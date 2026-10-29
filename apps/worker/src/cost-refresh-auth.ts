import { createHash } from "node:crypto";
import { costRefreshSecretName, type CostRefreshSecretKind, type SecretStore } from "@openmasu/runtime";
import type { FetchLike } from "./import/adapters.js";

type SafeReason = "reauth_required" | "source_rejected" | "source_invalid" | "source_unavailable" | "acquisition_timeout";
export class CostRefreshAuthError extends Error {
  constructor(readonly reason: SafeReason) { super(reason); }
  get retry(): boolean { return this.reason === "source_unavailable" || this.reason === "acquisition_timeout"; }
}

type Token = { value: string; refreshAt: number };
type Entry = { fingerprint: string; token?: Token; pending?: Promise<Token> };
type Scope = { tenantId: string; appId: string };
type TokenOptions = Scope & { secrets: SecretStore; fetch: FetchLike; signal?: AbortSignal };

function waitForCaller<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new CostRefreshAuthError("acquisition_timeout"));
    signal.addEventListener("abort", aborted, { once: true });
    // Keep handlers on the shared request even if this caller has left. Its
    // cancellation must not abort another caller's exchange or leak a rejection.
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

function credential(secrets: SecretStore, scope: Scope, kind: CostRefreshSecretKind): string | undefined {
  try {
    const value = secrets.read(costRefreshSecretName(scope.tenantId, scope.appId, kind));
    if (value !== undefined && (typeof value !== "string" || value.length < 1 || value.length > 16_384
      || /[\r\n\u0000]/.test(value))) throw new Error();
    return value;
  } catch { throw new CostRefreshAuthError("reauth_required"); }
}

async function tokenBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new CostRefreshAuthError("source_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new CostRefreshAuthError("source_unavailable");
      const part = await reader.read().catch(() => { throw new CostRefreshAuthError("source_unavailable"); });
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) { cancel(); throw new CostRefreshAuthError("source_invalid"); }
      chunks.push(part.value);
    }
    if (signal.aborted) throw new CostRefreshAuthError("source_unavailable");
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CostRefreshAuthError) throw error;
    throw new CostRefreshAuthError("source_invalid");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Process-local, bounded token reuse. Database claims own cross-process work. */
export class CostRefreshAuth {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maximumEntries: number;

  constructor(options: { now?: () => number; timeoutMs?: number; maximumEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumEntries = options.maximumEntries ?? 128;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10_000
      || !Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1 || this.maximumEntries > 1_000) {
      throw new Error("cost_auth_limit_invalid");
    }
  }

  invalidate(scope: Scope): void {
    this.entries.delete(costRefreshSecretName(scope.tenantId, scope.appId, "access_token"));
  }

  async google(options: TokenOptions): Promise<{ accessToken: string; developerToken: string }> {
    if (options.signal?.aborted) throw new CostRefreshAuthError("acquisition_timeout");
    const key = costRefreshSecretName(options.tenantId, options.appId, "access_token");
    let clientId: string | undefined, clientSecret: string | undefined, refreshToken: string | undefined;
    let developerToken: string | undefined;
    try {
      clientId = credential(options.secrets, options, "google_client_id");
      clientSecret = credential(options.secrets, options, "google_client_secret");
      refreshToken = credential(options.secrets, options, "google_refresh_token");
      developerToken = credential(options.secrets, options, "developer_token");
    } catch (error) { this.entries.delete(key); throw error; }
    if (!developerToken) throw new CostRefreshAuthError("source_rejected");
    const configured = [clientId, clientSecret, refreshToken].filter(value => value !== undefined).length;
    if (configured === 0) {
      this.entries.delete(key);
      const accessToken = credential(options.secrets, options, "access_token");
      if (!accessToken) throw new CostRefreshAuthError("source_rejected");
      return { accessToken, developerToken };
    }
    if (configured !== 3) { this.entries.delete(key); throw new CostRefreshAuthError("reauth_required"); }
    const fingerprint = createHash("sha256").update(JSON.stringify([clientId, clientSecret, refreshToken])).digest("hex");
    let entry = this.entries.get(key);
    if (entry?.fingerprint !== fingerprint) {
      this.entries.delete(key);
      if (this.entries.size >= this.maximumEntries) {
        const idle = [...this.entries].find(([, value]) => value.pending === undefined);
        if (!idle) throw new CostRefreshAuthError("source_unavailable");
        this.entries.delete(idle[0]);
      }
      entry = { fingerprint };
      this.entries.set(key, entry);
    }
    // Refresh five minutes before expiry. The clock is local token validity,
    // independent from a saved cost run's report watermark or retry as_of.
    if (entry.token && this.now() < entry.token.refreshAt) return { accessToken: entry.token.value, developerToken };
    if (!entry.pending) {
      const current = entry;
      current.pending = this.exchange(clientId!, clientSecret!, refreshToken!, options.fetch).then(token => {
        if (this.entries.get(key) === current) current.token = token;
        current.pending = undefined;
        return token;
      }, error => {
        current.token = undefined;
        current.pending = undefined;
        throw error;
      });
    }
    const token = await waitForCaller(entry.pending!, options.signal);
    return { accessToken: token.value, developerToken };
  }

  private async exchange(clientId: string, clientSecret: string, refreshToken: string, fetcher: FetchLike): Promise<Token> {
    const controller = new AbortController();
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CostRefreshAuthError("source_unavailable"));
      }, this.timeoutMs);
    });
    const request = async (): Promise<Token> => {
      const response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId,
          client_secret: clientSecret, refresh_token: refreshToken }),
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw new CostRefreshAuthError("source_unavailable"); }
      if (!response.ok) {
        // Status is sufficient. Never parse/log the provider's error body.
        void response.body?.cancel().catch(() => undefined);
        throw new CostRefreshAuthError(response.status === 408 || response.status === 429 || response.status >= 500
          ? "source_unavailable" : "reauth_required");
      }
      const body = await tokenBody(response, controller.signal);
      if (typeof body.access_token !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(body.access_token)
        || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"
        || typeof body.expires_in !== "number" || !Number.isSafeInteger(body.expires_in)
        || body.expires_in < 1 || body.expires_in > 86_400) throw new CostRefreshAuthError("source_invalid");
      return { value: body.access_token, refreshAt: startedAt + body.expires_in * 1_000 - 300_000 };
    };
    try { return await Promise.race([deadline, request()]); }
    catch (error) {
      if (error instanceof CostRefreshAuthError) throw error;
      throw new CostRefreshAuthError("source_unavailable");
    } finally { clearTimeout(timer!); }
  }
}
