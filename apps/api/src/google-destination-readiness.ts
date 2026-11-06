import { createHash } from "node:crypto";

const keys = ["operating_account_id", "conversion_action_id", "app_audience", "enabled", "readiness"];
export function previewGoogleDestination(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => ![...keys, "expected_revision", "preview_digest"].includes(key))) throw Error("google_destination_fields_invalid");
  if (typeof body.operating_account_id !== "string" || !/^\d{10}$/.test(body.operating_account_id)
    || typeof body.conversion_action_id !== "string" || !/^\d{1,32}$/.test(body.conversion_action_id)
    || typeof body.enabled !== "boolean" || !["general", "mixed", "child_directed"].includes(String(body.app_audience))) {
    throw Error("google_destination_configuration_invalid");
  }
  const raw = body.readiness ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("google_destination_readiness_invalid");
  const input = raw as Record<string, unknown>;
  const readinessKeys = ["source", "action_type", "action_status", "action_owner_account_id", "conversion_action_id", "access_model", "permission", "purpose"];
  if (Object.keys(input).some(key => !readinessKeys.includes(key))) throw Error("google_destination_readiness_invalid");
  const readiness = Object.fromEntries(readinessKeys.map(key => {
    const value = input[key] ?? "unknown";
    if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(value)) throw Error("google_destination_readiness_invalid");
    return [key, value];
  }));
  const blockers: string[] = [];
  if (readiness.source !== "operator_review") blockers.push("review_missing");
  if (readiness.action_type !== "UPLOAD_CLICKS") blockers.push("action_type_unsupported");
  if (readiness.action_status !== "ENABLED") blockers.push("action_not_enabled");
  if (readiness.action_owner_account_id !== body.operating_account_id || readiness.conversion_action_id !== body.conversion_action_id) blockers.push("action_scope_mismatch");
  if (readiness.access_model !== "direct") blockers.push("access_path_unsupported");
  if (readiness.permission !== "granted") blockers.push("permission_unconfirmed");
  if (readiness.purpose !== "click_import") blockers.push("purpose_unsupported");
  if (body.app_audience === "child_directed") blockers.push("child_directed");
  const definition = { operating_account_id: body.operating_account_id, conversion_action_id: body.conversion_action_id,
    app_audience: body.app_audience as "general" | "mixed" | "child_directed", enabled: body.enabled, readiness };
  return { definition, blockers, ready: blockers.length === 0, live_access_verified: false,
    preview_digest: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
    boundary: "Operator-reviewed direct-access click import only; not App Campaign integration or live access verification. No refunds, restatements, user data or additional identifiers." };
}
