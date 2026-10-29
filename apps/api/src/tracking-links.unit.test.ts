import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { createTrackingLink } from "./tracking-links.js";
import { buildTrackingLinkPreview, PREVIEW_CLICK_PLACEHOLDER } from "./tracking-link-preview.js";
import { renderTrackingLinkPreview } from "./dashboard/tracking-link-preview.js";
import { resolveRedirect, type TrackingLink } from "@openmasu/redirector-core";

describe("M7 tracking-link creation", () => {
  it("previews the shared routing decision without generating click identities or contacting destinations", () => {
    const link: TrackingLink = { tracking_link_id: "link:synthetic", tenant_id: "tenant-synthetic", app_id: "app-synthetic",
      slug: "synthetic___1", destination_kind: "play_store", destination_url: "https://play.google.com/store/apps/details",
      play_package_name: "dev.openmasu.synthetic", status: "active", deep_link_value: "/shop", deep_link_param_names: ["offer"] };
    const configuration = { fallbackUrl: "https://fallback.synthetic.example/", referrerMaximumEncodedCharacters: 512 };
    for (const platform of ["android", "ios", "other"] as const) {
      const params = new URLSearchParams({ platform, path: "/shop/item", dlp_offer: "synthetic" });
      const preview = buildTrackingLinkPreview(link, params, configuration);
      const live = resolveRedirect({ link, fallbackDestination: configuration.fallbackUrl, platform,
        now: "2026-10-29T00:00:00.000Z", clickId: PREVIEW_CLICK_PLACEHOLDER, deepLinkValue: "/shop/item", deepLinkParams: { offer: "synthetic" } });
      assert.equal(preview.destination, live.headers.location);
      assert.equal(preview.fallback_reason, platform === "android" ? null : "platform_not_supported");
      assert.deepEqual(preview, buildTrackingLinkPreview(link, params, configuration));
      assert.equal("click" in preview, false);
    }
    const active = new URLSearchParams({ platform: "android" });
    for (const status of ["paused", "archived"] as const) assert.equal(buildTrackingLinkPreview({ ...link, status }, active, configuration).fallback_reason, `link_${status}`);
    assert.equal(buildTrackingLinkPreview(link, new URLSearchParams({ platform: "android", path: "/../unsafe" }), configuration).fallback_reason, "invalid_deep_link_path");
    assert.equal(buildTrackingLinkPreview(link, active, { ...configuration, referrerMaximumEncodedCharacters: 54 }).deferred_status, "omitted_length");
    assert.equal(buildTrackingLinkPreview(link, new URLSearchParams({ platform: "android", dlp_offer: "unsafe value" }), configuration).dropped_parameter_count, 1);
    for (const parameters of [new URLSearchParams(), new URLSearchParams("platform=android&platform=ios"), new URLSearchParams("platform=android&next=https://unsafe.example"), new URLSearchParams("platform=android&dlp_unknown=x")]) {
      assert.throws(() => buildTrackingLinkPreview(link, parameters, configuration), /tracking_preview_/);
    }
    const custom = buildTrackingLinkPreview({ ...link, destination_kind: "custom_https", destination_url: "https://synthetic.example/?q=<unsafe>" }, active, configuration);
    assert.equal(custom.referrer, null); assert.equal(custom.deferred_status, "not_applicable");
    const html = renderTrackingLinkPreview(link.app_id, custom);
    assert.doesNotMatch(html, /<unsafe>|<script\b|javascript:|\son[a-z]+=/i);
    assert.match(html, /does not contact the destination/);
  });
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
