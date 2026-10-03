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
