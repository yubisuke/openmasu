import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAllowedDestination,
  assertDeepLinkValue,
  bindDeepLinkParameters,
  buildDeferredReferrer,
  classifyClientClass,
  decodeInstallReferrer,
  encodeInstallReferrer,
  fallbackResponse,
  prefetchEvidence,
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
    // A statistical smoke test must not turn correct CSPRNG output into a flaky CI gate.
    // 130 still rejects material alphabet bias while leaving a conservative tail margin.
    assert.ok(statistic < 130, `base64url chi-square statistic ${statistic} exceeded 130`);
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

  it("records bounded server prefetch evidence without issuing a click identifier", () => {
    const fallback = fallbackResponse("https://safe.example/");
    const result = prefetchEvidence({
      link: { ...activeLink, network: "synthetic-network", site_id: "synthetic-site" },
      fallbackDestination: "https://safe.example/",
      now: "2026-08-21T00:00:00.000Z",
      remoteClickRef: "synthetic-remote-ref",
      sourceRateClass: "elevated",
    });
    assert.deepEqual({ status: result.status, headers: result.headers, body: result.body }, fallback);
    assert.equal("click_id" in result.prefetch!, false);
    assert.deepEqual(result.prefetch, {
      bot_prefetch: true,
      tracking_link_id: "link:synthetic",
      tenant_id: "tenant-synthetic",
      app_id: "app-synthetic",
      redirector_click_at: "2026-08-21T00:00:00.000Z",
      campaign_id: "campaign-synthetic",
      network: "synthetic-network",
      site_id: "synthetic-site",
      remote_click_ref: "synthetic-remote-ref",
      source_rate_class: "elevated",
      client_class: "bot",
    });
  });

  it("DL-A-03 evaluates a 40-value destination grammar table", () => {
    const accepted = [
      "/a", "/shop/item/1", "/A-Z_0.~", "/one/two", "/a/b/c/d/e/f/g/h",
      `/${Array.from({ length: 8 }, (_, index) => String.fromCharCode(97 + index).repeat(31)).join("/")}`,
      "/event/summer-2026", "/item/_private", "/dots/are.ok", "/tilde/~ok",
    ];
    const rejected = [
      "..", "//", "a", "", "/", "/a//b", "/a/../b", "/a/./b", "/a?b", "/a#b",
      "/%2F", "/%2e%2e", "http://x", "https://x/a", "//evil.example", `/${"a".repeat(65)}`,
      "/a/b/c/d/e/f/g/h/i", `/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(64)}`,
      "/a b", "/a+b", "/a=b", "/a&b", "/a;b", "/a:b", "/a@b", "/a,b", "/a\\b", "/日本語", "/😀", "/a%20b",
    ];
    assert.equal(accepted.length + rejected.length, 40);
    assert.equal(accepted[5].length, 256);
    for (const value of accepted) assert.equal(assertDeepLinkValue(value), value);
    for (const value of rejected) assert.throws(() => assertDeepLinkValue(value), /deep_link_value_invalid/);
  });

  it("DL-A-04 and DL-A-05 bind only declared safe parameters without changing redirect identity", () => {
    const result = bindDeepLinkParameters(new URLSearchParams("dlp_code=abc&dlp_drop=bad&destination=x&url=x&next=x&dl=x&dlp_bad=space%20value&dlp_code=last"), ["code", "bad"]);
    assert.deepEqual(result.values, { code: "last" });
    assert.equal(result.dropped, 6);
    const base = resolveRedirect({ link: activeLink, fallbackDestination: "https://safe.example/", now: "2026-08-21T00:00:00.000Z", clickId: "AbCdEf0123456789_-abcd" });
    const ignored = resolveRedirect({ link: activeLink, fallbackDestination: "https://safe.example/", now: "2026-08-21T00:00:00.000Z", clickId: "AbCdEf0123456789_-abcd", deepLinkParams: bindDeepLinkParameters(new URLSearchParams("destination=x&url=x&next=x&dl=x"), []).values });
    assert.equal(JSON.stringify(ignored), JSON.stringify(base));
    assert.deepEqual(bindDeepLinkParameters(new URLSearchParams(`dlp_code=${"x".repeat(65)}`), ["code"]), { values: {}, dropped: 1 });
  });

  it("DL-A-11 keeps click entropy and omits an oversized destination", () => {
    const clickId = "AbCdEf0123456789_-abcd";
    const carried = buildDeferredReferrer({ clickId, deepLinkValue: "/shop/item/1", deepLinkParams: { code: "abc" }, maximumEncodedCharacters: 512 });
    assert.deepEqual(decodeInstallReferrer(carried.referrer), { omv: "1", cid: clickId, dl: "/shop/item/1", dlp_code: "abc" });
    assert.equal(carried.status, "carried");
    const omitted = buildDeferredReferrer({ clickId, deepLinkValue: `/${"a".repeat(64)}/${"b".repeat(64)}`, maximumEncodedCharacters: 40 });
    assert.equal(omitted.status, "omitted_length");
    assert.deepEqual(decodeInstallReferrer(omitted.referrer), { omv: "1", cid: clickId });
  });

  it("DL-A-12 preserves click entropy at the minimum referrer budget", () => {
    const values = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const result = resolveRedirect({
        link: activeLink,
        fallbackDestination: "https://safe.example/",
        now: "2026-08-21T00:00:00.000Z",
        referrerMaximumEncodedCharacters: 54,
      });
      const clickId = result.click?.click_id ?? "";
      assert.match(clickId, /^[A-Za-z0-9_-]{22,128}$/);
      values.add(clickId);
    }
    assert.equal(values.size, 10_000);
  });

  it("F-A-17 classifies normal and prefetch clicks using only the public bounded classes", () => {
    assert.equal(classifyClientClass("Synthetic Android Client"), "mobile_app_eligible");
    assert.equal(classifyClientClass("Synthetic Preview Fetcher"), "bot");
    assert.equal(classifyClientClass("Synthetic Desktop Client"), "other");
    const result = prefetchEvidence({
      link: activeLink,
      fallbackDestination: "https://safe.example/",
      now: "2026-08-21T00:00:00.000Z",
      clientClass: classifyClientClass("Synthetic Preview Fetcher"),
    });
    assert.equal(result.prefetch?.client_class, "bot");
    assert.equal(JSON.stringify(result).includes("Synthetic Preview Fetcher"), false);

    const normal = resolveRedirect({
      link: activeLink,
      fallbackDestination: "https://safe.example/",
      now: "2026-08-21T00:00:00.000Z",
      clickId: "AbCdEf0123456789_-bounded",
      clientClass: classifyClientClass("Synthetic Preview Fetcher"),
    });
    assert.equal(normal.click?.client_class, "bot");
    assert.equal(normal.click?.bot_prefetch, true);
    assert.equal(JSON.stringify(normal).includes("Synthetic Preview Fetcher"), false);

    const disabled = resolveRedirect({
      link: activeLink,
      fallbackDestination: "https://safe.example/",
      now: "2026-08-21T00:00:00.000Z",
      clickId: "AbCdEf0123456789_-disabled",
    });
    assert.equal(disabled.click?.client_class, undefined);
  });
});
