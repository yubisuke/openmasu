import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGoogleDataManagerIngestRequest,
  exactGoogleConversionValue,
  googleConversionTransactionId,
  googleDiagnosticPollPlan,
  normalizeGoogleConversionEligibility,
  parseGoogleDataManagerRequestStatus,
  retrieveGoogleDataManagerRequestStatus,
  sendGoogleDataManagerEvent,
  type GoogleConversionEligibilityInput,
} from "./google-conversion-delivery.js";

const eligible: GoogleConversionEligibilityInput = {
  verifiedResultId: "verification:synthetic-63",
  verificationVerdict: "verified",
  verifiedRecordId: "record:verified-synthetic-63",
  financialStatus: "settled",
  attributionStatus: "non_organic",
  attributionFinality: "final",
  clickNetwork: "google_ads",
  sourceQualifiedGclid: "syntheticGclid_63-safe",
  destinationEnabled: true,
  appAudience: "general",
  redacted: false,
  withdrawn: false,
  amountUnscaled: "1234567",
  amountScale: 4,
  currency: "JPY",
  eventTimestamp: "2026-08-24T01:02:03Z",
  operatingAccountId: "1234567890",
  conversionActionId: "9876543210",
};

function response(value: unknown, status = 200): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
}

describe("Google Data Manager conversion eligibility and request normalization", () => {
  it("builds one byte-stable APP event with only gclid and non-identifying conversion fields", () => {
    const first = buildGoogleDataManagerIngestRequest(eligible);
    const second = buildGoogleDataManagerIngestRequest({ ...eligible });
    assert.equal(first.body.equals(second.body), true);
    assert.equal(first.transactionId, googleConversionTransactionId(eligible.verifiedResultId));
    assert.deepEqual(JSON.parse(first.body.toString("utf8")), {
      destinations: [{
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" },
        productDestinationId: "9876543210",
      }],
      events: [{
        adIdentifiers: { gclid: "syntheticGclid_63-safe" },
        conversionValue: 123.4567,
        currency: "JPY",
        eventTimestamp: "2026-08-24T01:02:03.000Z",
        transactionId: first.transactionId,
        eventSource: "APP",
      }],
    });
    const text = first.body.toString("utf8").toLowerCase();
    for (const forbidden of ["installation", "purchase_token", "order_id", "ip_address", "user-agent",
      "mobile_device", "user_data", "email", "phone"]) assert.equal(text.includes(forbidden), false);
  });

  it("rejects extra identifier fields instead of spreading them into provider requests", () => {
    for (const forbidden of ["installationId", "playToken", "orderId", "ipAddress", "userAgent", "email"] as const) {
      assert.throws(() => normalizeGoogleConversionEligibility({ ...eligible, [forbidden]: "forbidden" }),
        /google_conversion_field_forbidden/);
    }
  });

  it("fails closed for every ineligible provenance and privacy state", () => {
    const cases: readonly [Partial<GoogleConversionEligibilityInput>, RegExp][] = [
      [{ verificationVerdict: "failed" }, /not_verified/],
      [{ verifiedRecordId: null }, /verified_record_id_invalid/],
      [{ financialStatus: "pending" }, /not_settled/],
      [{ attributionStatus: "organic" }, /not_non_organic/],
      [{ attributionStatus: "unattributed" }, /not_non_organic/],
      [{ attributionFinality: "provisional" }, /not_final/],
      [{ clickNetwork: "synthetic_other" }, /network_ineligible/],
      [{ sourceQualifiedGclid: "" }, /gclid_invalid/],
      [{ destinationEnabled: false }, /destination_disabled/],
      [{ appAudience: "child_directed" }, /child_directed/],
      [{ redacted: true }, /redacted/],
      [{ withdrawn: true }, /withdrawn/],
    ];
    for (const [change, expected] of cases) {
      assert.throws(() => buildGoogleDataManagerIngestRequest({ ...eligible, ...change }), expected);
    }
  });

  it("converts integer-plus-scale money exactly and rejects binary precision loss", () => {
    assert.equal(exactGoogleConversionValue("123", 2), 1.23);
    assert.equal(exactGoogleConversionValue("1", 9), 0.000000001);
    assert.equal(exactGoogleConversionValue("1000", 3), 1);
    assert.throws(() => exactGoogleConversionValue("9007199254740993", 0), /precision_loss/);
    assert.throws(() => exactGoogleConversionValue("1.2", 2), /money_invalid/);
    assert.throws(() => exactGoogleConversionValue("-1", 0), /money_invalid/);
  });
});

describe("Google Data Manager event transport", () => {
  it("posts to the fixed v1 endpoint with redirect:error and parses requestId", async () => {
    const prepared = buildGoogleDataManagerIngestRequest(eligible);
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const result = await sendGoogleDataManagerEvent(prepared, {
      accessToken: "synthetic-access-token",
      baseUrl: "http://127.0.0.1:8080",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return response({ requestId: "request:synthetic-63" });
      },
    });
    assert.deepEqual(result, { outcome: "accepted", requestId: "request:synthetic-63", httpStatus: 200 });
    assert.equal(capturedUrl, "http://127.0.0.1:8080/v1/events:ingest");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.redirect, "error");
    assert.deepEqual(Buffer.from(capturedInit?.body as Uint8Array), prepared.body);
    assert.equal(String((capturedInit?.headers as Record<string, string>).authorization).includes("synthetic-access-token"), true);
  });

  it("allows only the Google HTTPS endpoint or an explicit loopback synthetic endpoint", async () => {
    const prepared = buildGoogleDataManagerIngestRequest(eligible);
    for (const baseUrl of ["http://datamanager.googleapis.com", "https://example.invalid", "https://user@example.invalid"] ) {
      await assert.rejects(() => sendGoogleDataManagerEvent(prepared, {
        accessToken: "synthetic", baseUrl, fetch: async () => response({ requestId: "unused" }),
      }), /endpoint_/);
    }
  });

  it("classifies redirects, 429, 5xx, permanent 4xx, and transport errors without provider bodies", async () => {
    const prepared = buildGoogleDataManagerIngestRequest(eligible);
    for (const [status, expected] of [
      [302, { outcome: "terminal", reason: "redirect_rejected", httpStatus: 302 }],
      [429, { outcome: "retry", reason: "rate_limited", httpStatus: 429 }],
      [503, { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 }],
      [400, { outcome: "terminal", reason: "provider_rejected", httpStatus: 400 }],
    ] as const) {
      const result = await sendGoogleDataManagerEvent(prepared, {
        accessToken: "synthetic", baseUrl: "http://localhost:8080",
        fetch: async () => response({ error: "secret-bearing-provider-message" }, status),
      });
      assert.deepEqual(result, expected);
      assert.equal(JSON.stringify(result).includes("secret-bearing"), false);
    }
    const transportFailure = await sendGoogleDataManagerEvent(prepared, {
      accessToken: "synthetic", baseUrl: "http://localhost:8080",
      fetch: async () => { throw new Error("https://secret.invalid/?token=secret"); },
    });
    assert.deepEqual(transportFailure, { outcome: "retry", reason: "transport_error" });
  });

  it("bounds accepted response bytes and retries malformed or missing request IDs", async () => {
    const prepared = buildGoogleDataManagerIngestRequest(eligible);
    const config = { accessToken: "synthetic", baseUrl: "http://localhost:8080", maximumResponseBytes: 32 };
    assert.deepEqual(await sendGoogleDataManagerEvent(prepared, {
      ...config, fetch: async () => response("x".repeat(33)),
    }), { outcome: "retry", reason: "response_too_large", httpStatus: 200 });
    for (const value of ["not-json", {}, { requestId: "contains whitespace" }]) {
      assert.deepEqual(await sendGoogleDataManagerEvent(prepared, {
        ...config, maximumResponseBytes: 1024, fetch: async () => response(value),
      }), { outcome: "retry", reason: "response_invalid", httpStatus: 200 });
    }
  });
});

describe("Google Data Manager delayed diagnostics", () => {
  it("normalizes processing, success, partial success, and failure with safe enum counts", () => {
    const status = (requestStatus: string, extra: Record<string, unknown> = {}) => ({
      requestStatusPerDestination: [{ requestStatus, ...extra }],
    });
    assert.equal(parseGoogleDataManagerRequestStatus(status("PROCESSING")).status, "processing");
    assert.equal(parseGoogleDataManagerRequestStatus(status("SUCCESS", {
      warningInfo: { warningCounts: [{ reason: "PROCESSING_WARNING_REASON_EVENT_TOO_OLD", recordCount: "1" }] },
    })).status, "success");
    assert.deepEqual(parseGoogleDataManagerRequestStatus(status("PARTIAL_SUCCESS", {
      errorInfo: { errorCounts: [{ reason: "PROCESSING_ERROR_REASON_INVALID_GCLID", recordCount: "1" }] },
    })), {
      outcome: "status", status: "partial_success",
      errors: [{ reason: "PROCESSING_ERROR_REASON_INVALID_GCLID", recordCount: "1" }], warnings: [],
    });
    assert.equal(parseGoogleDataManagerRequestStatus(status("FAILED")).status, "failure");
    assert.throws(() => parseGoogleDataManagerRequestStatus(status("REQUEST_STATUS_UNKNOWN")), /request_status_invalid/);
    assert.throws(() => parseGoogleDataManagerRequestStatus(status("FAILED", {
      errorInfo: { errorCounts: [{ reason: "unsafe free text", recordCount: "1" }] },
    })), /diagnostic_invalid/);
  });

  it("retrieves status with a bounded requestId query and classifies HTTP failures", async () => {
    let captured = "";
    const result = await retrieveGoogleDataManagerRequestStatus("request:synthetic-63", {
      accessToken: "synthetic", baseUrl: "http://localhost:8080",
      fetch: async (input, init) => {
        captured = String(input);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        return response({ requestStatusPerDestination: [{ requestStatus: "SUCCESS" }] });
      },
    });
    assert.equal(captured, "http://localhost:8080/v1/requestStatus:retrieve?requestId=request%3Asynthetic-63");
    assert.deepEqual(result, { outcome: "status", status: "success", errors: [], warnings: [] });
    assert.deepEqual(await retrieveGoogleDataManagerRequestStatus("request:synthetic-63", {
      accessToken: "synthetic", baseUrl: "http://localhost:8080", fetch: async () => response({}, 503),
    }), { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 });
    await assert.rejects(() => retrieveGoogleDataManagerRequestStatus("unsafe request id", {
      accessToken: "synthetic", fetch: async () => response({}),
    }), /request_id_invalid/);
  });

  it("starts after 30 minutes, applies 1.3 backoff, caps at 60 minutes, and expires at 24 hours", () => {
    const acceptedAt = "2026-08-24T00:00:00.000Z";
    assert.deepEqual(googleDiagnosticPollPlan({ pollAttempt: 0, acceptedAt, now: acceptedAt }),
      { outcome: "poll_after", delayMilliseconds: 1_800_000 });
    assert.deepEqual(googleDiagnosticPollPlan({ pollAttempt: 1, acceptedAt, now: acceptedAt }),
      { outcome: "poll_after", delayMilliseconds: 2_340_000 });
    assert.deepEqual(googleDiagnosticPollPlan({ pollAttempt: 99, acceptedAt, now: acceptedAt }),
      { outcome: "poll_after", delayMilliseconds: 3_600_000 });
    assert.deepEqual(googleDiagnosticPollPlan({
      pollAttempt: 2, acceptedAt, now: "2026-08-25T00:00:00.000Z",
    }), { outcome: "expired" });
  });
});
