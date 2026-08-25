import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { createTrackingLink } from "./tracking-links.js";

describe("M7 tracking-link creation", () => {
  it("DL-A-04 rejects an invalid destination value before any database write", async () => {
    let queried = false;
    const pool = { connect: async () => { queried = true; throw new Error("unexpected_database_access"); } } as unknown as Pool;
    await assert.rejects(createTrackingLink({
      pool,
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      actorRef: "admin_key:synthetic",
      allowedOrigins: [],
      body: {
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
        play_package_name: "dev.openmasu.synthetic",
        deep_link_value: "https://untrusted.invalid/path",
      },
    }), /deep_link_value_invalid/);
    assert.equal(queried, false);
  });

  it("DL-A-11 applies the configured referrer budget before any database write", async () => {
    let queried = false;
    const pool = { connect: async () => { queried = true; throw new Error("unexpected_database_access"); } } as unknown as Pool;
    await assert.rejects(createTrackingLink({
      pool,
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      actorRef: "admin_key:synthetic",
      allowedOrigins: [],
      referrerMaximumEncodedCharacters: 40,
      body: {
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
        play_package_name: "dev.openmasu.synthetic",
        deep_link_value: "/shop/item/53",
      },
    }), /deep_link_referrer_budget_exceeded/);
    assert.equal(queried, false);
  });
});
