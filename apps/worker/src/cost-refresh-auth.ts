import { createHash, createPrivateKey, sign } from "node:crypto";
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
type Provider = "google_ads" | "apple_ads";
const tokenEndpoints = { google_ads: "https://oauth2.googleapis.com/token", apple_ads: "https://appleid.apple.com/auth/oauth2/token" } as const;

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
      || (kind === "apple_ads_private_key" ? /\u0000/.test(value) : /[\r\n\u0000]/.test(value)))) throw new Error();
    return value;
  } catch { throw new CostRefreshAuthError("reauth_required"); }
}

function appleClientSecret(clientId: string, teamId: string, keyId: string, pem: string, now: number): string {
  try {
    if (![clientId, teamId, keyId].every(value => /^[A-Za-z0-9._-]{1,256}$/.test(value))) throw new Error();
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    const iat = Math.floor(now / 1_000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, sub: clientId,
      aud: "https://appleid.apple.com", iat, exp: iat + 300 })}`;
    return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
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

  invalidate(scope: Scope, provider: Provider = "google_ads"): void {
    this.entries.delete(costRefreshSecretName(scope.tenantId, scope.appId,
      provider === "apple_ads" ? "apple_ads_access_token" : "access_token"));
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
    const token = await this.cached(key, fingerprint, "google_ads", () => new URLSearchParams({ grant_type: "refresh_token",
      client_id: clientId!, client_secret: clientSecret!, refresh_token: refreshToken! }), options);
    return { accessToken: token.value, developerToken };
  }

  async apple(options: TokenOptions): Promise<{ accessToken: string }> {
    if (options.signal?.aborted) throw new CostRefreshAuthError("acquisition_timeout");
    const key = costRefreshSecretName(options.tenantId, options.appId, "apple_ads_access_token");
    let clientId: string | undefined, teamId: string | undefined, keyId: string | undefined, pem: string | undefined;
    try {
      clientId = credential(options.secrets, options, "apple_ads_client_id");
      teamId = credential(options.secrets, options, "apple_ads_team_id");
      keyId = credential(options.secrets, options, "apple_ads_key_id");
      pem = credential(options.secrets, options, "apple_ads_private_key");
    } catch (error) { this.entries.delete(key); throw error; }
    const configured = [clientId, teamId, keyId, pem].filter(value => value !== undefined).length;
    if (configured === 0) {
      this.entries.delete(key);
      const accessToken = credential(options.secrets, options, "apple_ads_access_token");
      if (!accessToken) throw new CostRefreshAuthError("source_rejected");
      return { accessToken };
    }
    if (configured !== 4) { this.entries.delete(key); throw new CostRefreshAuthError("reauth_required"); }
    const fingerprint = createHash("sha256").update(JSON.stringify([clientId, teamId, keyId, pem])).digest("hex");
    const token = await this.cached(key, fingerprint, "apple_ads", () => new URLSearchParams({ grant_type: "client_credentials",
      client_id: clientId!, client_secret: appleClientSecret(clientId!, teamId!, keyId!, pem!, this.now()), scope: "searchadsorg" }), options);
    return { accessToken: token.value };
  }

  private async cached(key: string, fingerprint: string, provider: Provider, body: () => URLSearchParams, options: TokenOptions): Promise<Token> {
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
    if (entry.token && this.now() < entry.token.refreshAt) return entry.token;
    if (!entry.pending) {
      const current = entry;
      current.pending = this.exchange(provider, body, options.fetch).then(token => {
        if (this.entries.get(key) === current) current.token = token;
        current.pending = undefined;
        return token;
      }, error => {
        current.token = undefined;
        current.pending = undefined;
        throw error;
      });
    }
    return waitForCaller(entry.pending!, options.signal);
  }

  private async exchange(provider: Provider, fields: () => URLSearchParams, fetcher: FetchLike): Promise<Token> {
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
      const response = await fetcher(tokenEndpoints[provider], {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(provider === "apple_ads" ? { host: "appleid.apple.com" } : {}) },
        body: fields(),
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
        || body.expires_in < 1 || body.expires_in > 86_400
        || (provider === "apple_ads" && body.scope !== "searchadsorg")) throw new CostRefreshAuthError("source_invalid");
      return { value: body.access_token, refreshAt: startedAt + body.expires_in * 1_000 - 300_000 };
    };
    try { return await Promise.race([deadline, request()]); }
    catch (error) {
      if (error instanceof CostRefreshAuthError) throw error;
      throw new CostRefreshAuthError("source_unavailable");
    } finally { clearTimeout(timer!); }
  }
}
