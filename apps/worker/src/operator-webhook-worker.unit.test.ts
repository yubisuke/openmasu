import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  buildOperatorWebhookRequest,
  sendOperatorWebhook,
  type OperatorWebhookCandidate,
} from "./operator-webhook-worker.js";
import { buildOperatorWebhookDeletionRequest } from "./operator-webhook-deletions.js";
import { parseWebhookContentPolicy, previewWebhookContent, applyWebhookContent } from "@openmasu/runtime/webhook-content";
import { contentPolicyFromForm, renderWebhookContent } from "../../api/src/dashboard/webhook-content.js";

const secret = Buffer.from("synthetic-operator-webhook-secret-material-0001", "utf8");
const rawInstallation = "installation:must-not-leak";
const rawTransaction = "transaction:must-not-leak";
const baseCandidate: OperatorWebhookCandidate = {
  destination_id: "webhook:synthetic",
  endpoint_url: "https://events.example.test/openmasu",
  secret_ref: "encrypted:synthetic",
  logical_event_id: "logical:must-not-leak",
  record_id: "record:must-not-leak",
  app_id: "app-synthetic",
  event_name: "purchase",
  occurred_at: "2026-08-30T00:00:00.000Z",
  installation_id: rawInstallation,
  event_key: null,
  transaction_id: rawTransaction,
  original_transaction_id: null,
  amount_unscaled: "1234",
  amount_scale: 2,
  currency: "USD",
  financial_status: "settled",
  revenue_source: null,
  ad_network: null,
  country: null,
};

describe("operator webhook closed envelope", () => {
  it("shares one closed content policy between synthetic preview and final money/key/name fields", () => {
    for (const share_money of [false, true]) {
      const policy = parseWebhookContentPolicy({ mode: "explicit_v1", custom_events: { synthetic_allowed: "receiver_allowed" },
        event_names: { purchase: "order_recorded" }, share_money });
      const preview = previewWebhookContent(policy);
      for (const event_name of ["purchase", "refund", "ad_revenue", "custom_event"] as const) {
        const candidate = { ...baseCandidate, event_name, event_key: "synthetic_allowed", revenue_source: "mediation",
          content_policy: policy, policy_revision: 2, installation_id: null, transaction_id: null };
        const request = buildOperatorWebhookRequest({ candidate, deliveryId: "synthetic-delivery", emittedAt: baseCandidate.occurred_at, secret });
        const example = preview.examples.find(row => row.source_name === event_name && row.send)!;
        assert.deepEqual({ name: request.envelope.event.name, details: request.envelope.event.details }, example.event);
        assert.equal(request.envelope.policy_revision, 2);
        assert.equal(Object.hasOwn(request.envelope.event.details, "amount_unscaled"), share_money && event_name !== "custom_event");
      }
      assert.throws(() => buildOperatorWebhookRequest({ candidate: { ...baseCandidate, event_name: "custom_event", event_key: "not_allowed", content_policy: policy },
        deliveryId: "synthetic-delivery", emittedAt: baseCandidate.occurred_at, secret }), /content_filtered/);
      assert.equal(preview.examples.at(-1)?.send, false);
      assert.equal(applyWebhookContent({ name: "custom_event", details: { event_key: "constructor" } }, policy), undefined);
      assert.doesNotMatch(JSON.stringify(preview), /secret|installation_id|transaction_id|record_id|event_ref|subject_ref/);
      const history = { destination_id: "synthetic", events: ["purchase"], status: "active", revisions: [{ policy_revision: 1, definition: policy,
        definition_digest: preview.preview_digest, created_at: baseCandidate.occurred_at }] };
      const html = renderWebhookContent("synthetic-app", "synthetic-csrf", history, preview);
      assert.match(html, /Activate reviewed policy/); assert.doesNotMatch(html, /<script|onload=/);
      assert.deepEqual(contentPolicyFromForm(new URLSearchParams({ custom_events: "synthetic_allowed=receiver_allowed", event_names: "purchase=order_recorded",
        ...(share_money ? { share_money: "yes" } : {}) })), policy);
    }
    for (const invalid of [{ mode: "legacy_v1" }, { mode: "explicit_v1", custom_events: {}, event_names: { purchase: "refund" }, share_money: false },
      { mode: "explicit_v1", custom_events: { a: "same", b: "same" }, event_names: {}, share_money: false },
      { mode: "explicit_v1", custom_events: {}, event_names: {}, share_money: false, attributes: {} }]) assert.throws(() => parseWebhookContentPolicy(invalid));
  });
  it("uses only the already-delivered subject reference in a closed deletion notice", () => {
    const subjectRef = createHmac("sha256", secret).update(`openmasu:subject_ref:v1\0${rawInstallation}`).digest("hex");
    const prepared = buildOperatorWebhookDeletionRequest({ deliveryId: "018f0000-0000-7000-8000-000000000104",
      appId: "app-synthetic", subjectRef, recognizedAt: "2026-08-30T02:00:00.000Z", endpointUrl: baseCandidate.endpoint_url });
    assert.deepEqual(prepared.envelope, { schema: "openmasu.subject_deletion.v1",
      delivery_id: prepared.deliveryId, app_id: "app-synthetic", subject_ref: subjectRef, recognized_at: "2026-08-30T02:00:00.000Z" });
    assert.equal(prepared.requestDigest, createHash("sha256").update(prepared.body).digest("hex"));
    for (const value of [rawInstallation, rawTransaction, "privacy_request_id", "record_id", "event_ref", "payload", "secret_ref"])
      assert.equal(prepared.body.toString().includes(value), false, value);
    assert.throws(() => buildOperatorWebhookDeletionRequest({ deliveryId: prepared.deliveryId, appId: "app-synthetic",
      subjectRef: rawInstallation, recognizedAt: "2026-08-30T02:00:00.000Z", endpointUrl: baseCandidate.endpoint_url }),
    /operator_webhook_deletion_request_invalid/);
  });

  it("emits only destination-scoped references and closed purchase fields", () => {
    const prepared = buildOperatorWebhookRequest({
      candidate: baseCandidate,
      deliveryId: "018f0000-0000-7000-8000-000000000001",
      emittedAt: "2026-08-30T00:00:01.000Z",
      secret,
    });
    assert.deepEqual(prepared.envelope.event.details, {
      amount_unscaled: "1234",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
      transaction_ref: createHmac("sha256", secret)
        .update(`openmasu:transaction_ref:v1\0${rawTransaction}`, "utf8").digest("hex"),
    });
    const emitted = prepared.body.toString("utf8");
    for (const forbidden of [rawInstallation, rawTransaction, baseCandidate.logical_event_id,
      baseCandidate.record_id, "payload", "advertising_id", "provider_click_id"]) {
      assert.equal(emitted.includes(forbidden), false, forbidden);
    }
    assert.match(prepared.envelope.event.subject_ref ?? "", /^[a-f0-9]{64}$/);
    assert.match(prepared.envelope.event.event_ref, /^[a-f0-9]{64}$/);
  });

  it("maps each allowed event to a bounded details object", () => {
    const cases: Array<[OperatorWebhookCandidate["event_name"], Partial<OperatorWebhookCandidate>, object]> = [
      ["session_start", {}, {}],
      ["custom_event", { event_key: "synthetic_event" }, { event_key: "synthetic_event" }],
      ["refund", { original_transaction_id: "transaction:original" }, {
        amount_unscaled: "1234", amount_scale: 2, currency: "USD", financial_status: "settled",
        transaction_ref: createHmac("sha256", secret)
          .update("openmasu:transaction_ref:v1\0transaction:original", "utf8").digest("hex"),
      }],
      ["ad_revenue", {
        transaction_id: null, financial_status: null, revenue_source: "mediation",
        ad_network: "synthetic_network", country: "US",
      }, {
        amount_unscaled: "1234", amount_scale: 2, currency: "USD", revenue_source: "mediation",
        ad_network: "synthetic_network", country: "US",
      }],
    ];
    for (const [event_name, overrides, expected] of cases) {
      const prepared = buildOperatorWebhookRequest({
        candidate: { ...baseCandidate, event_name, ...overrides },
        deliveryId: `018f0000-0000-7000-8000-${randomBytes(6).toString("hex")}`,
        emittedAt: "2026-08-30T00:00:01.000Z",
        secret,
      });
      assert.deepEqual(prepared.envelope.event.details, expected);
      const emitted = prepared.body.toString("utf8");
      for (const forbidden of [
        rawInstallation, rawTransaction, baseCandidate.logical_event_id, baseCandidate.record_id,
        "installation_id", "transaction_id", "original_transaction_id", "logical_event_id",
        "record_id", "raw_payload", "advertising_id", "provider_click_id", "secret_ref", "endpoint_url",
      ]) {
        assert.equal(emitted.includes(forbidden), false, `${event_name}:${forbidden}`);
      }
    }
  });
});

describe("operator webhook transport", () => {
  let receiver: ReturnType<typeof createServer>;
  let origin = "";
  const received: Array<{ body: Buffer; signature: string; deliveryId: string; attempt: string; signingRevision: string }> = [];

  before(async () => {
    receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        body: Buffer.concat(chunks),
        signature: String(request.headers["x-openmasu-signature"] ?? ""),
        deliveryId: String(request.headers["x-openmasu-delivery-id"] ?? ""),
        attempt: String(request.headers["x-openmasu-attempt"] ?? ""),
        signingRevision: String(request.headers["x-openmasu-key-revision"] ?? ""),
      });
      if (request.url === "/slow") return;
      response.writeHead(request.url === "/retry" ? 429 : request.url === "/reject" ? 400
        : request.url === "/redirect" ? 302 : 204, request.url === "/redirect" ? { location: "/ok" } : {});
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  });

  after(async () => {
    receiver.close();
    await once(receiver, "close");
  });

  const deliver = async (path: string) => {
    const prepared = buildOperatorWebhookRequest({
      candidate: { ...baseCandidate, endpoint_url: `${origin}${path}` },
      deliveryId: "018f0000-0000-7000-8000-000000000099",
      emittedAt: "2026-08-30T00:00:01.000Z",
      secret,
    });
    return { prepared, result: await sendOperatorWebhook(prepared, secret, {
      destinationAllowlist: [origin], attempt: 2, signingRevision: 7, allowSyntheticLoopback: true,
    }) };
  };

  it("pins the loopback synthetic receiver, signs the exact body, and accepts 2xx", async () => {
    const { prepared, result } = await deliver("/ok");
    assert.deepEqual(result, { outcome: "accepted", httpStatus: 204 });
    const captured = received.at(-1)!;
    assert.deepEqual(captured.body, prepared.body);
    assert.equal(captured.signature, `sha256=${createHmac("sha256", secret).update(prepared.body).digest("hex")}`);
    assert.equal(captured.deliveryId, prepared.deliveryId);
    assert.equal(captured.attempt, "2");
    assert.equal(captured.signingRevision, "7");
  });

  it("rotates only the transport signature and refuses an expired overlap at the request boundary", async () => {
    const prepared = buildOperatorWebhookRequest({ candidate: { ...baseCandidate, endpoint_url: `${origin}/ok` },
      deliveryId: "018f0000-0000-7000-8000-000000000103", emittedAt: "2026-08-30T00:00:01.000Z", secret });
    const signingKey = Buffer.from("synthetic-independent-signing-key-00000002");
    const deadline = "2026-08-30T01:00:00.000Z";
    const sent = await sendOperatorWebhook(prepared, signingKey, { destinationAllowlist: [origin], attempt: 1,
      signingRevision: 2, signingValidUntil: deadline, now: () => new Date("2026-08-30T00:59:59.999Z"), allowSyntheticLoopback: true });
    assert.equal(sent.outcome, "accepted");
    const captured = received.at(-1)!;
    assert.deepEqual(captured.body, prepared.body, "rotation never rebuilds saved references or request bytes");
    assert.equal(captured.signingRevision, "2");
    assert.equal(captured.signature, `sha256=${createHmac("sha256", signingKey).update(prepared.body).digest("hex")}`);
    const before = received.length;
    assert.deepEqual(await sendOperatorWebhook(prepared, signingKey, { destinationAllowlist: [origin], attempt: 2,
      signingRevision: 2, signingValidUntil: deadline, now: () => new Date(deadline), allowSyntheticLoopback: true }),
    { outcome: "suppressed", reason: "signing_key_expired" });
    assert.equal(received.length, before, "expiry suppresses the network request, not just its receipt");
  });

  it("retries a deletion notice through the same signer without changing body or delivery identity", async () => {
    const prepared = buildOperatorWebhookDeletionRequest({ deliveryId: "018f0000-0000-7000-8000-000000000105",
      appId: "app-synthetic", subjectRef: "a".repeat(64), recognizedAt: "2026-08-30T02:00:00.000Z", endpointUrl: `${origin}/retry` });
    const start = received.length;
    for (const attempt of [1, 2]) assert.deepEqual(await sendOperatorWebhook(prepared, secret, {
      destinationAllowlist: [origin], signingRevision: 3, attempt, allowSyntheticLoopback: true,
    }), { outcome: "retry", reason: "rate_limited", httpStatus: 429 });
    const attempts = received.slice(start);
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.deepEqual(attempt.body, prepared.body);
      assert.equal(attempt.deliveryId, prepared.deliveryId);
      assert.equal(attempt.signingRevision, "3");
      assert.equal(attempt.signature, `sha256=${createHmac("sha256", secret).update(prepared.body).digest("hex")}`);
    }
    assert.deepEqual(attempts.map(attempt => attempt.attempt), ["1", "2"]);
  });

  it("classifies retryable, terminal, and redirect responses without reading receiver bodies", async () => {
    assert.deepEqual((await deliver("/retry")).result,
      { outcome: "retry", reason: "rate_limited", httpStatus: 429 });
    assert.deepEqual((await deliver("/reject")).result,
      { outcome: "terminal", reason: "receiver_rejected", httpStatus: 400 });
    assert.deepEqual((await deliver("/redirect")).result,
      { outcome: "terminal", reason: "redirect_rejected", httpStatus: 302 });
  });

  it("bounds request bytes and treats a receiver timeout as retryable", async () => {
    const oversized = buildOperatorWebhookRequest({
      candidate: { ...baseCandidate, endpoint_url: `${origin}/ok` },
      deliveryId: "018f0000-0000-7000-8000-000000000100",
      emittedAt: "2026-08-30T00:00:01.000Z",
      secret,
    });
    assert.deepEqual(await sendOperatorWebhook(oversized, secret, {
      destinationAllowlist: [origin], attempt: 1, allowSyntheticLoopback: true,
      maximumRequestBytes: oversized.body.length - 1,
    }), { outcome: "terminal", reason: "request_too_large" });

    const slow = buildOperatorWebhookRequest({
      candidate: { ...baseCandidate, endpoint_url: `${origin}/slow` },
      deliveryId: "018f0000-0000-7000-8000-000000000101",
      emittedAt: "2026-08-30T00:00:01.000Z",
      secret,
    });
    assert.deepEqual(await sendOperatorWebhook(slow, secret, {
      destinationAllowlist: [origin], attempt: 3, allowSyntheticLoopback: true,
      timeoutMilliseconds: 100,
    }), { outcome: "retry", reason: "timeout" });

    const unresolved = buildOperatorWebhookRequest({
      candidate: baseCandidate,
      deliveryId: "018f0000-0000-7000-8000-000000000102",
      emittedAt: "2026-08-30T00:00:01.000Z",
      secret,
    });
    assert.deepEqual(await sendOperatorWebhook(unresolved, secret, {
      destinationAllowlist: ["https://events.example.test"],
      attempt: 1,
      timeoutMilliseconds: 100,
      lookup: () => new Promise(() => undefined),
    }), { outcome: "retry", reason: "dns_unavailable" });
  });
});
