import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { costRefreshSecretName, EnvironmentSecretStore, type SecretStore } from "@openmasu/runtime";
import { CostRefreshAuth, CostRefreshAuthError } from "./cost-refresh-auth.js";
import type { FetchLike } from "./import/adapters.js";

const scope = { tenantId: "tenant-synthetic-auth", appId: "app-synthetic-auth" };
const key = (kind: Parameters<typeof costRefreshSecretName>[2], appId = scope.appId) => costRefreshSecretName(scope.tenantId, appId, kind);
const credentials = () => new EnvironmentSecretStore({
  [key("google_client_id")]: { value: "synthetic-client" },
  [key("google_client_secret")]: { value: "synthetic-client-secret" },
  [key("google_refresh_token")]: { value: "synthetic-refresh" },
  [key("developer_token")]: { value: "synthetic-developer" },
  [key("access_token")]: { value: "synthetic-static-must-not-win" },
});
const token = (value: string) => Response.json({ access_token: value, token_type: "Bearer", expires_in: 3_600 });
const rejects = async (pending: Promise<unknown>, reason: CostRefreshAuthError["reason"]) => {
  await assert.rejects(pending, error => error instanceof CostRefreshAuthError && error.reason === reason && error.message === reason);
};

describe("bounded Google cost credential renewal", () => {
  it("shares concurrent renewal and reuses tokens only until five minutes before expiry", async () => {
    let now = Date.parse("2026-10-29T00:00:00.000Z"), calls = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetcher: FetchLike = async (url, init) => {
      const count = ++calls;
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), {
        grant_type: "refresh_token", client_id: "synthetic-client", client_secret: "synthetic-client-secret", refresh_token: "synthetic-refresh",
      });
      if (count === 1) await pending;
      return token(`synthetic-access-${count}`);
    };
    const auth = new CostRefreshAuth({ now: () => now });
    const options = { ...scope, secrets: credentials(), fetch: fetcher };
    const first = auth.google(options), second = auth.google(options);
    assert.equal(calls, 1); release();
    assert.deepEqual(await Promise.all([first, second]), [
      { accessToken: "synthetic-access-1", developerToken: "synthetic-developer" },
      { accessToken: "synthetic-access-1", developerToken: "synthetic-developer" },
    ]);
    now += 3_299_999;
    assert.equal((await auth.google(options)).accessToken, "synthetic-access-1"); assert.equal(calls, 1);
    now += 1;
    assert.equal((await auth.google(options)).accessToken, "synthetic-access-2");
    now += 86_400_000;
    assert.equal((await auth.google(options)).accessToken, "synthetic-access-3"); assert.equal(calls, 3);
  });

  it("does not let one aborted acquisition cancel another caller's shared exchange", async () => {
    const auth = new CostRefreshAuth();
    let finish!: () => void, requestSignal: AbortSignal | undefined, calls = 0;
    const response = new Promise<void>(resolve => { finish = resolve; });
    const fetcher: FetchLike = async (_url, init) => { calls++; requestSignal = init?.signal ?? undefined; await response; return token("synthetic-shared"); };
    const firstController = new AbortController();
    const options = { ...scope, secrets: credentials(), fetch: fetcher };
    const first = rejects(auth.google({ ...options, signal: firstController.signal }), "acquisition_timeout");
    const second = auth.google(options);
    firstController.abort(new Error("synthetic-private-abort-detail"));
    await first; assert.equal(requestSignal?.aborted, false); assert.equal(calls, 1);
    finish(); assert.equal((await second).accessToken, "synthetic-shared");
  });

  it("invalidates file-backed credential rotations without allowing an old renewal to replace the new token", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmasu-cost-auth-"));
    try {
      const path = join(root, "refresh-token"); writeFileSync(path, "synthetic-old-refresh");
      const secrets = new EnvironmentSecretStore({
        [key("google_client_id")]: { value: "synthetic-client" }, [key("google_client_secret")]: { value: "synthetic-client-secret" },
        [key("google_refresh_token")]: { file: path }, [key("developer_token")]: { value: "synthetic-developer" },
      });
      let release!: () => void, calls = 0;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const fetcher: FetchLike = async (_url, init) => {
        calls++;
        const old = new URLSearchParams(String(init?.body)).get("refresh_token") === "synthetic-old-refresh";
        if (old) await blocked;
        return token(old ? "synthetic-old-access" : "synthetic-new-access");
      };
      const auth = new CostRefreshAuth(), options = { ...scope, secrets, fetch: fetcher };
      const old = auth.google(options);
      writeFileSync(path, "synthetic-new-refresh");
      assert.equal((await auth.google(options)).accessToken, "synthetic-new-access");
      release(); await old;
      assert.equal((await auth.google(options)).accessToken, "synthetic-new-access"); assert.equal(calls, 2);
      auth.invalidate(scope);
      await auth.google(options); assert.equal(calls, 3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves static tokens but refuses incomplete renewal settings and sanitizes secret-file failures", async () => {
    const auth = new CostRefreshAuth(), forbidden: FetchLike = async () => { throw new Error("must not fetch"); };
    const entries = {
      [key("access_token")]: { value: "synthetic-static" }, [key("developer_token")]: { value: "synthetic-developer" },
    };
    assert.deepEqual(await auth.google({ ...scope, secrets: new EnvironmentSecretStore(entries), fetch: forbidden }), {
      accessToken: "synthetic-static", developerToken: "synthetic-developer",
    });
    await rejects(auth.google({ ...scope, secrets: new EnvironmentSecretStore({ ...entries,
      [key("google_refresh_token")]: { value: "synthetic-partial" } }), fetch: forbidden }), "reauth_required");
    await rejects(auth.google({ ...scope, secrets: { read() { throw new Error("synthetic-private-path-and-token"); }, require() { throw new Error(); } }, fetch: forbidden }), "reauth_required");
    await rejects(auth.google({ ...scope, secrets: new EnvironmentSecretStore({}), fetch: forbidden }), "source_rejected");
  });

  it("bounds and sanitizes OAuth failures, malformed responses, oversized bodies and ignored cancellation", async () => {
    for (const status of [400, 401, 403, 408, 429, 500, 503]) {
      await rejects(new CostRefreshAuth().google({ ...scope, secrets: credentials(), fetch: async () =>
        new Response("synthetic-private-token-provider-detail", { status }) }),
      [408, 429, 500, 503].includes(status) ? "source_unavailable" : "reauth_required");
    }
    for (const body of [{ access_token: "synthetic", token_type: "Basic", expires_in: 3_600 },
      { access_token: "synthetic", token_type: "Bearer", expires_in: 0 },
      { access_token: "synthetic\nprivate", token_type: "Bearer", expires_in: 3_600 }]) {
      await rejects(new CostRefreshAuth().google({ ...scope, secrets: credentials(), fetch: async () => Response.json(body) }), "source_invalid");
    }
    for (const body of ["synthetic-private-invalid-json", "x".repeat(65_537)]) {
      await rejects(new CostRefreshAuth().google({ ...scope, secrets: credentials(), fetch: async () => new Response(body) }), "source_invalid");
    }
    await rejects(new CostRefreshAuth().google({ ...scope, secrets: credentials(), fetch: async () => { throw new Error("synthetic-private-transport"); } }), "source_unavailable");
    await rejects(new CostRefreshAuth().google({ ...scope, secrets: credentials(), fetch: async () =>
      new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic-private-stream")); } })) }), "source_unavailable");
    await rejects(new CostRefreshAuth({ timeoutMs: 10 }).google({ ...scope, secrets: credentials(),
      fetch: async () => new Promise<Response>(() => undefined) }), "source_unavailable");
    let cancelled = false;
    await rejects(new CostRefreshAuth({ timeoutMs: 10 }).google({ ...scope, secrets: credentials(),
      fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }), "source_unavailable");
    assert.equal(cancelled, true);
  });

  it("keeps scope-isolated cache capacity bounded while an exchange is active", async () => {
    const auth = new CostRefreshAuth({ maximumEntries: 1 });
    let finish!: () => void, calls = 0;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const secrets: SecretStore = {
      read(name) { return name.endsWith(":developer_token") ? "synthetic-developer" : "synthetic-credential"; },
      require() { throw new Error("not used"); },
    };
    const fetcher: FetchLike = async () => { calls++; if (calls === 1) await blocked; return token(`synthetic-${calls}`); };
    const first = auth.google({ ...scope, secrets, fetch: fetcher });
    await rejects(auth.google({ ...scope, appId: "app-other", secrets, fetch: fetcher }), "source_unavailable");
    assert.equal(calls, 1); finish(); await first;
    assert.equal((await auth.google({ ...scope, appId: "app-other", secrets, fetch: fetcher })).accessToken, "synthetic-2");
    assert.equal((await auth.google({ ...scope, secrets, fetch: fetcher })).accessToken, "synthetic-3");
  });
});
