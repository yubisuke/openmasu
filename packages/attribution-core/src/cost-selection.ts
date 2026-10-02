/** Explicit dimensions, not provider/fixture digest conventions, identify a revision. */
export type ScopedCost = {
  tenant_id: string;
  app_id: string;
  network: string;
  campaign_id?: string | null;
  ad_group_id?: string | null;
  country?: string | null;
  date: string;
  cost_record_id: string;
  as_of: string;
};

const optionalDimensions = ["campaign_id", "ad_group_id", "country"] as const;
const textOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const revisionOrder = (left: ScopedCost, right: ScopedCost) =>
  textOrder(left.as_of, right.as_of) || textOrder(left.cost_record_id, right.cost_record_id);

/**
 * Call after scope, grouping and watermark selection. Missing dimensions mean
 * unknown coverage, not proven non-overlap. Do not arbitrarily prefer a parent
 * or its detail rows: preserve candidates and report unsafe overlap separately.
 */
export function selectDisjointCosts<T extends ScopedCost>(input: readonly T[]): {
  rows: T[];
  overlapping: boolean;
} {
  const revisions = new Map<string, T>();
  for (const row of input) {
    const key = JSON.stringify([row.tenant_id, row.app_id, row.network, row.date,
      ...optionalDimensions.map((field) => row[field] ?? null)]);
    const previous = revisions.get(key);
    if (!previous || revisionOrder(previous, row) < 0) revisions.set(key, row);
  }
  const rows = [...revisions.values()].sort(revisionOrder);
  // Eight nullable-dimension masks keep the overlap check linear in row count.
  // Each mask indexes its projections onto all subsets of its known dimensions.
  const cells = new Map<string, Map<number, Map<number, Set<string>>>>();
  let overlapping = false;
  for (const row of rows) {
    const dimensions = optionalDimensions.map((field) => row[field] ?? null);
    const mask = dimensions.reduce<number>((value, dimension, bit) =>
      value | (dimension === null ? 0 : 1 << bit), 0);
    const project = (subset: number) => JSON.stringify(dimensions.filter((_, bit) => subset & (1 << bit)));
    const cellKey = JSON.stringify([row.tenant_id, row.app_id, row.network, row.date]);
    let cell = cells.get(cellKey);
    if (!cell) { cell = new Map(); cells.set(cellKey, cell); }
    for (const [previousMask, projections] of cell) {
      if (projections.get(previousMask & mask)?.has(project(previousMask & mask))) overlapping = true;
    }
    let projections = cell.get(mask);
    if (!projections) { projections = new Map(); cell.set(mask, projections); }
    for (let subset = mask; ; subset = (subset - 1) & mask) {
      let values = projections.get(subset);
      if (!values) { values = new Set(); projections.set(subset, values); }
      values.add(project(subset));
      if (subset === 0) break;
    }
  }
  return { rows, overlapping };
}
