export type GoogleCostDetailSelection = Readonly<{
  version: 1;
  grain: "ad_group" | "ad";
  coverage: "explicit_selection";
  country_scope: "all" | "geo_country";
  selections: readonly Readonly<{ campaign_id: string; ad_group_id: string; provider_ad_id?: string; creative_id?: string }>[];
}>;

/** Explicit finite provider IDs, never a guessed provider-ad to first-party-creative join. */
export function normalizeGoogleCostDetail(value: unknown): GoogleCostDetailSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("cost_detail_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "country_scope,coverage,grain,selections,version"
      || input.version !== 1 || !["ad_group", "ad"].includes(String(input.grain)) || input.coverage !== "explicit_selection"
      || !["all", "geo_country"].includes(String(input.country_scope))) throw Error("cost_detail_unsupported");
  // v25's country segment reference does not list ad_group_ad. Do not invent a geographic allocation.
  if (input.grain === "ad" && input.country_scope !== "all") throw Error("cost_detail_country_grain_unsupported");
  if (!Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > 100) throw Error("cost_detail_selection_limit");
  const seen = new Set<string>(), creativeBindings = new Set<string>();
  const selections = input.selections.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("cost_detail_mapping_invalid");
    const row = item as Record<string, unknown>;
    const fields = input.grain === "ad" ? ["ad_group_id", "campaign_id", "creative_id", "provider_ad_id"] : ["ad_group_id", "campaign_id"];
    if (Object.keys(row).sort().join(",") !== fields.join(",")) throw Error("cost_detail_mapping_invalid");
    for (const field of ["campaign_id", "ad_group_id", ...(input.grain === "ad" ? ["provider_ad_id"] : [])]) {
      if (typeof row[field] !== "string" || !/^[1-9]\d{0,18}$/.test(row[field]) || BigInt(row[field]) > 9223372036854775807n) throw Error("cost_detail_provider_id_invalid");
    }
    const key = JSON.stringify([row.campaign_id, row.ad_group_id, row.provider_ad_id ?? null]);
    if (seen.has(key)) throw Error("cost_detail_duplicate_provider_key");
    seen.add(key);
    if (input.grain === "ad") {
      if (typeof row.creative_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.creative_id)) throw Error("cost_detail_creative_binding_required");
      const binding = JSON.stringify([row.campaign_id, row.ad_group_id, row.creative_id]);
      if (creativeBindings.has(binding)) throw Error("cost_detail_ambiguous_creative_binding");
      creativeBindings.add(binding);
    }
    return { campaign_id: row.campaign_id as string, ad_group_id: row.ad_group_id as string,
      ...(input.grain === "ad" ? { provider_ad_id: row.provider_ad_id as string, creative_id: row.creative_id as string } : {}) };
  }).sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return { version:1, grain:input.grain as GoogleCostDetailSelection["grain"], coverage:"explicit_selection",
    country_scope:input.country_scope as GoogleCostDetailSelection["country_scope"], selections };
}
