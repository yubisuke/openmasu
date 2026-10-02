import { randomBytes } from "node:crypto";
import { signServerRequest } from "../apps/api/src/server-auth.js";

export interface BackendHttpConfiguration { origin: string; appId: string; serverKeyId: string; serverSecret: string; reportBearer: string }
export class BackendHttpError extends Error {
  constructor(readonly status: number | "unknown", readonly retry: "correct_input" | "backoff_new_signature" | "inspect_receipt") {
    super(`backend_http_${status}`);
  }
}
export function backendHttpClient(config: BackendHttpConfiguration) {
  const base = new URL(config.origin);
  if (base.origin !== config.origin || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))) throw new Error("backend_origin_invalid");
  const request = async (path: string, init: RequestInit) => {
    let response: Response;
    try { response = await fetch(new URL(path, base), { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) }); }
    catch { throw new BackendHttpError("unknown", "inspect_receipt"); }
    if (!response.ok) throw new BackendHttpError(response.status, response.status === 429 ? "backoff_new_signature" : response.status >= 500 ? "inspect_receipt" : "correct_input");
    return response;
  };
  return {
    async sendEvents(records: readonly Record<string, unknown>[]): Promise<{ ingest_batch_id: string; status: "pending" }> {
      const body = Buffer.from(JSON.stringify({ records }));
      const timestampMs = Date.now(), nonce = randomBytes(18).toString("base64url");
      const path = "/v1/events/server";
      const signature = signServerRequest(config.serverSecret, { method: "POST", path, appId: config.appId, serverKeyId: config.serverKeyId, timestampMs, nonce, body });
      const response = await request(path, { method: "POST", body, headers: {
        "content-type": "application/json", "x-openmasu-app-id": config.appId,
        "x-openmasu-server-key-id": config.serverKeyId, "x-openmasu-timestamp-ms": String(timestampMs), "x-openmasu-nonce": nonce, "x-openmasu-signature": signature,
      } });
      return response.json();
    },
    async reportPage(path: "/v1/reports/metrics" | "/v1/reports/records" | "/v1/audit/differences", selection: URLSearchParams): Promise<{ data: Record<string, unknown>[]; next_cursor?: string }> {
      const query = new URLSearchParams(selection); query.set("app_id", config.appId); query.set("format", "json");
      const response = await request(`${path}?${query}`, { headers: { authorization: `Bearer ${config.reportBearer}` } });
      return response.json();
    },
  };
}
