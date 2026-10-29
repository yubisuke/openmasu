import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { it } from "node:test";
import type { Pool } from "pg";
import { InboxCapacityError, type PayloadStore } from "@openmasu/runtime";
import { createRedirectorHandler } from "./handler.js";

it("redirector normal and prefetch routes expose retryable capacity responses without a successful redirect", async () => {
  const oldMode = process.env.OPENMASU_INBOX_ADMISSION_ENABLED;
  process.env.OPENMASU_INBOX_ADMISSION_ENABLED = "off";
  try {
    for (const prefetch of [false, true]) for (const reason of ["inbox_app_capacity", "inbox_global_capacity"] as const) {
      const pool = { connect: async () => ({
        query: async (sql: string) => ({ rows: sql.includes("control.tracking_links_current") ? [{
          tracking_link_id: "link-synthetic-capacity", tenant_id: "tenant-synthetic", app_id: "app-synthetic",
          slug: "syntheticlink12", destination_kind: "play_store", destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
          play_package_name: "dev.openmasu.synthetic", campaign_id: "campaign-synthetic", status: "active",
        }] : [] }), release() {},
      }) } as unknown as Pool;
      const handler = createRedirectorHandler({ pool, tenantId: "tenant-synthetic", geoMode: "off",
        fallbackUrl: "https://synthetic.example/fallback", limiter: { allow: () => true },
        payloadStore: { write: async () => { throw new InboxCapacityError(reason, 13); } } as unknown as PayloadStore });
      let done!: () => void;
      const completed = new Promise<void>((resolve) => { done = resolve; });
      const response = { statusCode: 0, headers: {} as Record<string, string>,
        writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; },
        end() { done(); return this; } };
      handler({ method: "GET", url: "/r/syntheticlink12", headers: { "user-agent": "Synthetic Android", ...(prefetch ? { purpose: "prefetch" } : {}) },
        socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage, response as unknown as ServerResponse);
      await completed;
      assert.equal(response.statusCode, reason === "inbox_app_capacity" ? 429 : 503);
      assert.equal(response.headers["retry-after"], "13");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers.location, undefined);
    }
  } finally {
    if (oldMode === undefined) delete process.env.OPENMASU_INBOX_ADMISSION_ENABLED;
    else process.env.OPENMASU_INBOX_ADMISSION_ENABLED = oldMode;
  }
});
