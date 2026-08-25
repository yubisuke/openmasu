import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAllowedDestination,
  decodeInstallReferrer,
  encodeInstallReferrer,
  fallbackResponse,
  randomClickId,
  randomSlug,
  resolveRedirect,
  type TrackingLink,
} from "./index.js";

const activeLink: TrackingLink = {
  tracking_link_id: "link:synthetic",
  tenant_id: "tenant-synthetic",
  app_id: "app-synthetic",
  slug: "AbCdEf0123_-",
  destination_kind: "play_store",
  destination_url: "https://play.google.com/store/apps/details?id=example.invalid",
  play_package_name: "dev.openmasu.synthetic",
  campaign_id: "campaign-synthetic",
  status: "active",
};

describe("redirector core", () => {
  it("generates 72-bit slugs and unbiased 264-bit click identifiers", () => {
    assert.match(randomSlug((size) => Buffer.alloc(size, 1)), /^[A-Za-z0-9_-]{12}$/);
    assert.match(randomClickId((size) => Buffer.alloc(size, 2)), /^[A-Za-z0-9_-]{44}$/);
    const clicks = new Set(Array.from({ length: 10_000 }, () => randomClickId()));
    assert.equal(clicks.size, 10_000);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const counts = new Map([...alphabet].map((character) => [character, 0]));
    for (const click of clicks) for (const character of click) counts.set(character, counts.get(character)! + 1);
    const expected = clicks.size * 44 / alphabet.length;
    const statistic = [...counts.values()].reduce((sum, count) => sum + ((count - expected) ** 2 / expected), 0);
    assert.ok(statistic < 100, `base64url chi-square statistic ${statistic} exceeded 100`);
  });

  it("round-trips the minimal referrer and reserved characters exactly once", () => {
    const clickId = "AbCdEf0123456789_-abcd";
    const referrer = encodeInstallReferrer(clickId, { probe: "%+&=" });
    assert.deepEqual(decodeInstallReferrer(referrer), { omv: "1", cid: clickId, probe: "%+&=" });
    assert.ok(Buffer.byteLength(encodeInstallReferrer(clickId), "utf8") < 64);
  });

  it("allows only configured HTTPS or Play destinations", () => {
    assert.doesNotThrow(() => assertAllowedDestination("https://play.google.com/store/apps/details?id=x", []));
    assert.doesNotThrow(() => assertAllowedDestination("https://owned.example/path", ["https://owned.example"]));
    assert.throws(() => assertAllowedDestination("http://owned.example/path", ["https://owned.example"]), /scheme_not_allowed/);
    assert.throws(() => assertAllowedDestination("https://attacker.example/path", ["https://owned.example"]), /origin_not_allowed/);
  });

  it("ignores request-supplied redirect targets and resolves stored links", () => {
    const result = resolveRedirect({
      link: activeLink,
      fallbackDestination: "https://safe.example/",
      now: "2026-08-19T00:00:00.000Z",
      clickId: "AbCdEf0123456789_-abcd",
    });
    assert.equal(new URL(result.headers.location).hostname, "play.google.com");
    assert.equal(result.click?.campaign_id, "campaign-synthetic");
  });

  it("returns byte-identical fallbacks for every unavailable state", () => {
    const fallback = JSON.stringify(fallbackResponse("https://safe.example/"));
    for (const link of [undefined, { ...activeLink, status: "paused" as const }, { ...activeLink, status: "archived" as const }]) {
      assert.equal(JSON.stringify(resolveRedirect({ link, fallbackDestination: "https://safe.example/", now: "2026-08-19T00:00:00.000Z" })), fallback);
    }
  });
});
