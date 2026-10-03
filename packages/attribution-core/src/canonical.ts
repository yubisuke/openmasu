import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

/** RFC 8785 serialization shared without importing the evaluator. */
export function jcs(value: unknown): string {
  return canonicalize(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(jcs(value), "utf8").digest("hex");
}
