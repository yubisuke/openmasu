/** Qualified IANA keys, never the machine's default zone or a guessed fixed offset. */
export const COHORT_TIME_ZONES = ["UTC", "Asia/Tokyo", "America/New_York"] as const;
export type CohortTimeZone = typeof COHORT_TIME_ZONES[number];
const formatters = new Map<CohortTimeZone, Intl.DateTimeFormat>();
function parts(value: Date, zone: CohortTimeZone): Record<string, string> {
  if (!COHORT_TIME_ZONES.includes(zone) || !Number.isFinite(value.valueOf())) throw new Error("calendar_time_invalid");
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(value).map(part => [part.type, part.value]));
}
export function cohortLocalDate(value: string | Date, zone: CohortTimeZone): string {
  const p = parts(typeof value === "string" ? new Date(value) : value, zone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function addCalendarDays(day: string, count: number): string {
  const epoch = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(epoch)
      || new Date(epoch).toISOString().slice(0, 10) !== day || !Number.isSafeInteger(count)) throw new Error("calendar_date_invalid");
  return new Date(epoch + count * 86_400_000).toISOString().slice(0, 10);
}
/** Resolve a local midnight from its IANA offset; day arithmetic happens before resolution. */
export function cohortDayStart(day: string, zone: CohortTimeZone): string {
  addCalendarDays(day, 0);
  const target = Date.parse(`${day}T00:00:00.000Z`);
  let instant = target;
  for (let iteration = 0; iteration < 4; iteration++) {
    const p = parts(new Date(instant), zone);
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`);
    const correction = target - local;
    if (correction === 0) return new Date(instant).toISOString();
    instant += correction;
  }
  throw new Error("calendar_midnight_unresolvable");
}
export function cohortCalendarDayIndex(install: string, outcome: string, zone: CohortTimeZone): number {
  return (Date.parse(cohortLocalDate(outcome, zone)) - Date.parse(cohortLocalDate(install, zone))) / 86_400_000;
}
