import { isVerifiedPurchaseProjection } from "@openmasu/contracts/definitions";

type Any = Record<string, any>;
export type EngagementInput = { attempt: Any; attribution: Any; campaignId: string; trackingLinkId: string | null };
const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const scope = (attempt: Any) => JSON.stringify([attempt.server.tenant_id, attempt.server.app_id, attempt.record.payload.installation_id]);

/** Retain the pre-redaction choice so deletion never transfers credit to an older open. */
export function engagementInputs(included: readonly Any[], attributions: readonly Any[], cutoff: string): EngagementInput[] {
  return included.filter(attempt => attempt.record.event_name === "deep_link_open").flatMap(attempt => {
    const resolution = attempt.server.deep_link_resolution;
    if (resolution?.status !== "active" || typeof resolution.campaign_id !== "string" || !resolution.campaign_id) return [];
    const attribution = attributions.filter(row => row.tenant_id === attempt.server.tenant_id && row.app_id === attempt.server.app_id
      && row.subject_scope === "engagement_level" && row.subject_ref === `engagement:${attempt.record.record_id}`
      && row.decided_at <= cutoff && row.input_cutoff_at <= cutoff)
      .sort((a, b) => textOrder(b.decided_at, a.decided_at) || textOrder(a.attribution_id, b.attribution_id))[0];
    if (attribution?.status !== "non_organic" || attribution.method !== "deep_link") return [];
    return [{ attempt, attribution, campaignId: resolution.campaign_id, trackingLinkId: resolution.tracking_link_id ?? null }];
  }).sort((a, b) => textOrder(a.attempt.server.tenant_id, b.attempt.server.tenant_id)
    || textOrder(a.attempt.server.app_id, b.attempt.server.app_id) || textOrder(a.attempt.record.record_id, b.attempt.record.record_id));
}

export function engagementSnapshotRows(inputs: readonly EngagementInput[], digest: (value: unknown) => string): unknown[][] {
  return inputs.map(row => [row.attempt.server.tenant_id, row.attempt.server.app_id, row.attempt.record.record_id,
    row.trackingLinkId, row.campaignId, row.attribution.attribution_id, digest(row.attribution)]);
}

export function engagementValue(input: {
  opens: readonly EngagementInput[]; visible: readonly Any[]; definition: Any; grouping: Any;
  available: (attempt: Any) => boolean; money: (payload: Any, occurredAt: string) => bigint;
}): bigint | undefined {
  const { opens, definition, grouping } = input;
  if (typeof grouping?.metric_date !== "string" || Object.keys(grouping).some(key => !["metric_date", "campaign_id"].includes(key))) {
    throw new Error("engagement_metric_requires_anchor_date");
  }
  const selected = (open: EngagementInput) => input.available(open.attempt)
    && new Date(open.attempt.record.occurred_at).toISOString().slice(0, 10) === grouping.metric_date
    && (grouping.campaign_id === undefined || grouping.campaign_id === open.campaignId);
  if (!opens.some(selected)) return undefined;
  const ordered = [...opens].sort((a, b) => Date.parse(b.attempt.record.occurred_at) - Date.parse(a.attempt.record.occurred_at)
    || textOrder(a.attempt.record.record_id, b.attempt.record.record_id));
  const converted = new Set<string>();
  let revenue = 0n;
  for (const outcome of input.visible) {
    const count = definition.definition.calculation === "converted_installations";
    if (count ? outcome.record.event_name !== "custom_event" || outcome.record.payload.event_key !== definition.conversion_event_key
      : outcome.record.event_name !== "ad_revenue" || outcome.record.payload.subject_scope !== "installation_level") continue;
    const at = Date.parse(outcome.record.occurred_at);
    // Choose before grouping and availability. A later open for a different
    // campaign, or a removed selected open, must not credit a prior campaign.
    const open = ordered.find(candidate => scope(candidate.attempt) === scope(outcome)
      && Date.parse(candidate.attempt.record.occurred_at) <= at);
    if (!open || at >= Date.parse(open.attempt.record.occurred_at) + 86_400_000 || !selected(open)) continue;
    if (count) converted.add(scope(outcome));
    else revenue += input.money(outcome.record.payload, outcome.record.occurred_at);
  }
  return definition.definition.calculation === "converted_installations" ? BigInt(converted.size) : revenue;
}

/** Independent opt-in. Historical 24h artifacts continue through engagementValue. */
export function engagementPolicyValue(input: {
  opens: readonly EngagementInput[]; included: readonly Any[]; visible: readonly Any[];
  definition: Any; grouping: Any; available: (attempt: Any) => boolean;
  money: (payload: Any, occurredAt: string) => bigint; refundTarget: (refund: Any) => Any | undefined;
}): { value: bigint } | { undefined_reason: "empty_cohort" | "insufficient_activity_history" } {
  const { definition, grouping } = input;
  if (typeof grouping?.metric_date !== "string" || Object.keys(grouping).some(key => !["metric_date", "campaign_id"].includes(key)))
    throw new Error("engagement_metric_requires_anchor_date");
  const inactivityDays = definition.engagement_inactivity_days;
  const windowDays = definition.definition.window.day + 1;
  if (!Number.isInteger(inactivityDays) || inactivityDays < 0 || inactivityDays > 90
      || !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) throw new Error("engagement_policy_window_invalid");
  const at = (item: Any) => Date.parse(item.record.occurred_at);
  const selected = (open: EngagementInput) => input.available(open.attempt)
    && open.attempt.record.occurred_at.slice(0, 10) === grouping.metric_date
    && (grouping.campaign_id === undefined || grouping.campaign_id === open.campaignId);
  const state = new Map<EngagementInput, "eligible" | "active" | "unknown">();
  for (const open of input.opens) {
    if (inactivityDays === 0) { state.set(open, "eligible"); continue; }
    const start = at(open.attempt) - inactivityDays * 86_400_000;
    const history = input.included.filter(item => scope(item) === scope(open.attempt)
      && ["sdk-android", "sdk-ios"].includes(item.record.producer) && at(item) < at(open.attempt));
    const activity = history.filter(item => at(item) >= start
      && ["session_start", "custom_event", "deep_link_open"].includes(item.record.event_name));
    if (activity.some(input.available)) state.set(open, "active");
    else if (activity.some(item => !input.available(item)) || !history.some(item =>
      item.record.event_name === "install" && at(item) <= start && input.available(item))) state.set(open, "unknown");
    else state.set(open, "eligible");
  }
  const population = input.opens.filter(selected);
  if (population.some(open => state.get(open) === "unknown")) return { undefined_reason: "insufficient_activity_history" };
  if (!population.some(open => state.get(open) === "eligible")) return { undefined_reason: "empty_cohort" };
  const ordered = [...input.opens].sort((a, b) => at(b.attempt) - at(a.attempt)
    || textOrder(a.attempt.record.record_id, b.attempt.record.record_id));
  // An active, unavailable or differently grouped winner still suppresses older opens.
  const winner = (item: Any) => ordered.find(open => scope(open.attempt) === scope(item) && at(open.attempt) <= at(item));
  const credited = (open: EngagementInput | undefined, item: Any) => open !== undefined && selected(open)
    && state.get(open) === "eligible" && at(item) < at(open.attempt) + windowDays * 86_400_000;
  const verified = (item: Any) => isVerifiedPurchaseProjection(item.record.producer, item.server.policy_digest);
  if (definition.definition.numerator === "purchase_net_revenue") {
    const purchaseKey = (item: Any) => JSON.stringify([item.server.tenant_id, item.server.app_id, item.record.record_id]);
    const purchases = new Map<string, { purchase: Any; open: EngagementInput }>();
    let value = 0n;
    for (const purchase of input.visible) {
      if (purchase.record.event_name !== "purchase" || purchase.record.payload.financial_status !== "settled" || !verified(purchase)) continue;
      const open = winner(purchase);
      if (!credited(open, purchase)) continue;
      purchases.set(purchaseKey(purchase), { purchase, open: open! });
      value += input.money(purchase.record.payload, purchase.record.occurred_at);
    }
    for (const refund of input.visible) {
      if (refund.record.event_name !== "refund" || refund.record.payload.financial_status !== "settled" || !verified(refund)) continue;
      const target = input.refundTarget(refund);
      const original = target && purchases.get(purchaseKey(target));
      if (!original || at(refund) < at(original.purchase) || !credited(original.open, refund)) continue;
      if (input.visible.some(reversal => reversal.record.event_name === "refund"
        && reversal.record.payload.financial_status === "reversed" && verified(reversal)
        && reversal.server.tenant_id === refund.server.tenant_id && reversal.server.app_id === refund.server.app_id
        && reversal.record.payload.reverses_refund_record_id === refund.record.record_id)) continue;
      value -= input.money(refund.record.payload, refund.record.occurred_at);
    }
    return { value };
  }
  const count = definition.definition.calculation === "converted_installations";
  const converted = new Set<string>();
  let value = 0n;
  for (const outcome of input.visible) {
    if (count ? outcome.record.event_name !== "custom_event" || outcome.record.payload.event_key !== definition.conversion_event_key
      : outcome.record.event_name !== "ad_revenue" || outcome.record.payload.subject_scope !== "installation_level") continue;
    if (!credited(winner(outcome), outcome)) continue;
    if (count) converted.add(scope(outcome));
    else value += input.money(outcome.record.payload, outcome.record.occurred_at);
  }
  return { value: count ? BigInt(converted.size) : value };
}
