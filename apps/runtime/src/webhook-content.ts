import { createHash } from "node:crypto";
import { OPERATOR_WEBHOOK_EVENTS as operatorWebhookEventNames } from "./webhook-security.js";

export type WebhookContentPolicy = {
  mode: "explicit_v1";
  custom_events: Record<string, string>;
  event_names: Record<string, string>;
  share_money: boolean;
};
export type StoredWebhookContentPolicy = WebhookContentPolicy | { mode: "legacy_v1" };
export const defaultWebhookContentPolicy: WebhookContentPolicy = { mode: "explicit_v1", custom_events: {}, event_names: {}, share_money: false };
const label = /^[a-z][a-z0-9_]{0,63}$/;
function dictionary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("operator_webhook_content_invalid");
  return value as Record<string, unknown>;
}
export function parseWebhookContentPolicy(input: unknown): WebhookContentPolicy {
  const body = dictionary(input);
  if (Object.keys(body).some(key => !["mode", "custom_events", "event_names", "share_money"].includes(key))
    || body.mode !== "explicit_v1" || typeof body.share_money !== "boolean") throw Error("operator_webhook_content_invalid");
  const custom = dictionary(body.custom_events), names = dictionary(body.event_names);
  if (Object.keys(custom).length > 20 || Object.keys(names).some(key => !operatorWebhookEventNames.includes(key as never))) throw Error("operator_webhook_content_invalid");
  const normalize = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, value]) => {
    if (!label.test(key) || typeof value !== "string" || !label.test(value)) throw Error("operator_webhook_content_invalid");
    return [key, value];
  }));
  const customEvents = normalize(custom), eventNames = normalize(names);
  if (new Set(Object.values(customEvents)).size !== Object.keys(customEvents).length
    || new Set(operatorWebhookEventNames.map(name => Object.hasOwn(eventNames, name) ? eventNames[name] : name)).size !== operatorWebhookEventNames.length) {
    throw Error("operator_webhook_content_name_collision");
  }
  return { mode: "explicit_v1", custom_events: customEvents, event_names: eventNames, share_money: body.share_money };
}
export const webhookContentDigest = (policy: StoredWebhookContentPolicy): string => createHash("sha256").update(JSON.stringify(policy)).digest("hex");

/** The same closed transformation is used by preview and the final sender. */
export function applyWebhookContent<T extends { name: string; details: Readonly<Record<string, unknown>> }>(event: T, stored: StoredWebhookContentPolicy): T | undefined {
  if (stored.mode === "legacy_v1") return event;
  const policy = parseWebhookContentPolicy(stored);
  const details = { ...event.details };
  if (event.name === "custom_event") {
    if (typeof details.event_key !== "string" || !Object.hasOwn(policy.custom_events, details.event_key)) return undefined;
    details.event_key = policy.custom_events[details.event_key];
  }
  if (!policy.share_money) for (const key of ["amount_unscaled", "amount_scale", "currency"]) delete details[key];
  return { ...event, name: Object.hasOwn(policy.event_names, event.name) ? policy.event_names[event.name] : event.name, details };
}

export function previewWebhookContent(input: unknown, allowedEvents: readonly string[] = operatorWebhookEventNames) {
  const policy = parseWebhookContentPolicy(input);
  const examples = operatorWebhookEventNames.filter(name => name !== "custom_event").map(name => ({ name, details: name === "session_start" ? {}
    : name === "ad_revenue" ? { amount_unscaled: "1234", amount_scale: 2, currency: "USD", revenue_source: "mediation" }
    : { amount_unscaled: "1234", amount_scale: 2, currency: "USD", financial_status: "settled" } }));
  let blocked = "synthetic_not_allowed";
  while (Object.hasOwn(policy.custom_events, blocked)) blocked += "_x";
  const events: { name: string; details: Record<string, unknown> }[] = [...examples,
    ...Object.keys(policy.custom_events).map(event_key => ({ name: "custom_event", details: { event_key } })),
    { name: "custom_event", details: { event_key: blocked } }];
  return { policy, preview_digest: webhookContentDigest(policy), synthetic_only: true,
    examples: events.map(event => {
      const projected = allowedEvents.includes(event.name) ? applyWebhookContent(event, policy) : undefined;
      return { source_name: event.name, source_key: event.details.event_key, send: projected !== undefined, event: projected };
    }) };
}
