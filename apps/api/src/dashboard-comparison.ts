import type { IncomingMessage } from "node:http";
import { jcs } from "@openmasu/attribution-core/canonical";
import { aggregateCsvToSnapshot, AggregateCsvError, csvLimits } from "./aggregate-csv-snapshot.js";
import { parseSnapshot } from "./cohort-comparison.js";
import { readRawBody, RequestBodyError } from "./raw-body.js";

export const comparisonWorkflowLimits = { inputBytes: csvLimits.bytes, requestBytes: 3 * csvLimits.bytes + 16 * 1024,
  outputBytes: 32 * 1024 * 1024, milliseconds: 30_000 } as const;
export class ComparisonWorkflowError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
export type ComparisonPair = { left: ReturnType<typeof parseSnapshot>; right: ReturnType<typeof parseSnapshot> };
export type ComparisonSubmission = ComparisonPair & { action: "review" | "result" | "json" | "html"; allowExternalDeclaration: boolean };

export function checkComparisonDeadline(deadline: number) {
  if (performance.now() >= deadline) throw new ComparisonWorkflowError("comparison_timeout", 408);
}
export function boundedComparisonOutput(value: string, deadline: number) {
  checkComparisonDeadline(deadline);
  if (Buffer.byteLength(value, "utf8") > comparisonWorkflowLimits.outputBytes) throw new ComparisonWorkflowError("comparison_output_limit", 413);
  return value;
}
function decode(bytes: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ComparisonWorkflowError("comparison_invalid_utf8"); }
}
function parseJson(text: string) {
  try { return JSON.parse(text) as unknown; } catch { throw new ComparisonWorkflowError("comparison_invalid_json"); }
}
export function validateComparisonPair(left: unknown, right: unknown, scope: { tenantId: string; appId: string }): ComparisonPair {
  let pair: ComparisonPair;
  try { pair = { left: parseSnapshot(left), right: parseSnapshot(right) }; }
  catch { throw new ComparisonWorkflowError("comparison_invalid_snapshot"); }
  for (const snapshot of [pair.left, pair.right]) {
    if (Buffer.byteLength(jcs(snapshot), "utf8") > comparisonWorkflowLimits.inputBytes) throw new ComparisonWorkflowError("comparison_input_limit", 413);
    if (snapshot.acquisition && (snapshot.acquisition.scope.tenant_id !== scope.tenantId || snapshot.acquisition.scope.app_id !== scope.appId)) {
      throw new ComparisonWorkflowError("comparison_scope_mismatch", 403);
    }
  }
  return pair;
}
/** Bounded text-only multipart handling; no file, history, payload store or subprocess. */
export async function readComparisonSubmission(request: IncomingMessage, scope: { tenantId: string; appId: string },
  verifyCsrf: (token: string) => boolean, deadline: number): Promise<ComparisonSubmission> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^multipart\/form-data;\s*boundary=(?:"[A-Za-z0-9'()+_,./:=? -]{1,70}"|[A-Za-z0-9'()+_,./:=?-]{1,70})$/i.test(contentType)) {
    throw new ComparisonWorkflowError("comparison_multipart_required", 415);
  }
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > comparisonWorkflowLimits.requestBytes)) throw new ComparisonWorkflowError("comparison_request_limit", 413);
  checkComparisonDeadline(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let body: Buffer;
  try {
    body = await Promise.race([readRawBody(request, comparisonWorkflowLimits.requestBytes), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new ComparisonWorkflowError("comparison_timeout", 408)); request.destroy(); }, Math.max(1, deadline - performance.now()));
    })]);
  } catch (error) {
    if (error instanceof RequestBodyError) throw new ComparisonWorkflowError(error.message === "request_too_large" ? "comparison_request_limit" : "comparison_interrupted", error.statusCode);
    throw error;
  } finally { if (timer) clearTimeout(timer); }
  // Scalar fields also need strict UTF-8; FormData's ordinary text decoder replaces errors.
  decode(body);
  let form: FormData;
  try { form = await new Request("http://openmasu.local/comparison", { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(body) }).formData(); }
  catch { throw new ComparisonWorkflowError("comparison_invalid_multipart"); }
  checkComparisonDeadline(deadline);
  const action = form.get("action"), expected = action === "review"
    ? ["action", "csrf_token", "saved_json", "external_csv", "mapping_json"] : ["action", "csrf_token", "left", "right", "external_opt_in"];
  if (!["review", "result", "json", "html"].includes(String(action))) throw new ComparisonWorkflowError("comparison_invalid_action");
  for (const key of form.keys()) if (!expected.includes(key) || form.getAll(key).length !== 1) throw new ComparisonWorkflowError("comparison_invalid_fields");
  const token = form.get("csrf_token");
  if (typeof token !== "string" || !verifyCsrf(token)) throw new ComparisonWorkflowError("csrf_rejected", 403);
  let left: unknown, right: unknown;
  if (action === "review") {
    const files: Record<string, Uint8Array> = {};
    for (const key of ["saved_json", "external_csv", "mapping_json"]) {
      const file = form.get(key);
      if (!file || typeof file === "string" || file.size === 0) throw new ComparisonWorkflowError("comparison_file_required");
      if (file.size > comparisonWorkflowLimits.inputBytes) throw new ComparisonWorkflowError("comparison_input_limit", 413);
      files[key] = new Uint8Array(await file.arrayBuffer());
    }
    left = parseJson(decode(files.saved_json));
    try { right = aggregateCsvToSnapshot(files.external_csv, parseJson(decode(files.mapping_json))); }
    catch (error) {
      if (error instanceof AggregateCsvError) throw new ComparisonWorkflowError(`comparison_csv_${error.code}`);
      throw error;
    }
  } else {
    const read = (key: string) => {
      const value = form.get(key);
      if (typeof value !== "string" || !value) throw new ComparisonWorkflowError("comparison_snapshot_required");
      if (Buffer.byteLength(value, "utf8") > comparisonWorkflowLimits.inputBytes) throw new ComparisonWorkflowError("comparison_input_limit", 413);
      return parseJson(value);
    };
    left = read("left"); right = read("right");
    const optIn = form.get("external_opt_in");
    if (optIn !== null && optIn !== "yes") throw new ComparisonWorkflowError("comparison_invalid_opt_in");
  }
  const pair = validateComparisonPair(left, right, scope);
  checkComparisonDeadline(deadline);
  return { ...pair, action: action as ComparisonSubmission["action"], allowExternalDeclaration: action !== "review" && form.get("external_opt_in") === "yes" };
}
