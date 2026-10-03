import { sha256 } from "./canonical.js";
import { cohortLocalDate } from "@openmasu/contracts/definitions";

export const DAY_MS = 86_400_000;

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compositeKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

export function sortByKey<T>(values: T[], key: (value: T) => readonly string[]): T[] {
  return [...values].sort((a, b) => {
    const aKey = [...key(a), sha256(a)];
    const bKey = [...key(b), sha256(b)];
    for (let index = 0; index < aKey.length; index += 1) {
      const comparison = compareText(aKey[index], bKey[index]);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

export class TimestampInvalidError extends Error {
  readonly exitCode = 1;

  constructor(field: string, value: unknown) {
    super(`timestamp_invalid: ${field}=${String(value)}`);
    this.name = "TimestampInvalidError";
  }
}

export function time(value: string | undefined, field: string): number {
  if (!value) throw new TimestampInvalidError(field, value);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TimestampInvalidError(field, value);
  }
  return parsed.getTime();
}

export function dateAt(value: string, zone: "UTC" | "Asia/Tokyo" | "America/New_York", field: string): string {
  if (zone === "America/New_York") return cohortLocalDate(new Date(time(value, field)), zone);
  const offset = zone === "Asia/Tokyo" ? 9 * 3_600_000 : 0;
  return new Date(time(value, field) + offset).toISOString().slice(0, 10);
}

export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}
