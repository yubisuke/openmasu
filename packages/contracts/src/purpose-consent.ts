/**
 * Opt-in purpose consent projection. Callers supply only authenticated,
 * schema-valid, accepted controls from one installation credential scope.
 * This module neither determines a legal basis nor authenticates a declaration.
 */
export const CONSENT_PURPOSES = ["attribution", "analytics", "revenue_measurement"] as const;
export type ConsentPurpose = typeof CONSENT_PURPOSES[number];
export type ConsentState = "granted" | "denied" | "withdrawn" | "not_required" | "unknown";
export type PurposeConsentControl = Readonly<{
  processing_purpose_id?: ConsentPurpose;
  consent_state: ConsentState;
  consent_revision?: number;
  recognized_sequence: number;
  recognized_at: string;
}>;
export type PurposeConsentSnapshot = Readonly<{
  processing_purpose_id: ConsentPurpose;
  consent_state: Exclude<ConsentState, "unknown">;
  consent_revision: number;
  recognized_sequence: number;
  recognized_at: string;
  conflicting_revision: boolean;
  unversioned_withdrawal_sequence?: number;
  unversioned_withdrawal_at?: string;
}>;

const stopped = (state: ConsentState) => state === "denied" || state === "withdrawn";
const validSequence = (value: number) => Number.isSafeInteger(value) && value >= 0;

function validateControl(control: PurposeConsentControl): void {
  if (!validSequence(control.recognized_sequence)
    || typeof control.recognized_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(control.recognized_at)
    || !Number.isFinite(Date.parse(control.recognized_at)) || new Date(control.recognized_at).toISOString() !== control.recognized_at
    || !["granted", "denied", "withdrawn", "not_required", "unknown"].includes(control.consent_state)
    || control.processing_purpose_id !== undefined && !CONSENT_PURPOSES.includes(control.processing_purpose_id)
    || control.consent_revision !== undefined && (!validSequence(control.consent_revision) || control.consent_revision === 0)
    || control.processing_purpose_id !== undefined && control.consent_revision === undefined) {
    throw Error("purpose_consent_control_invalid");
  }
}

/**
 * Resolve at an authoritative receipt sequence, not device time or input order.
 * Higher client revisions win, but conflicting declarations at one revision
 * cannot grant consent. A late unversioned withdrawal remains a conservative
 * barrier until a fresh higher revision is recognized after it.
 */
export function purposeConsentAt(controls: readonly PurposeConsentControl[], sequence: number): PurposeConsentSnapshot[] {
  if (!validSequence(sequence)) throw Error("purpose_consent_sequence_invalid");
  for (const control of controls) validateControl(control);
  const eligible = controls.filter(control => control.recognized_sequence <= sequence && control.consent_state !== "unknown");
  return CONSENT_PURPOSES.flatMap(processing_purpose_id => {
    const scoped = eligible.filter(control => control.processing_purpose_id === undefined || control.processing_purpose_id === processing_purpose_id);
    const order = (a: PurposeConsentControl, b: PurposeConsentControl) => a.recognized_sequence - b.recognized_sequence
      || (a.recognized_at < b.recognized_at ? -1 : a.recognized_at > b.recognized_at ? 1 : 0)
      || (a.consent_state < b.consent_state ? -1 : a.consent_state > b.consent_state ? 1 : 0);
    const legacy = scoped.filter(control => control.consent_revision === undefined && stopped(control.consent_state)).sort(order).at(-1);
    const versioned = scoped.filter(control => control.consent_revision !== undefined);
    const revision = versioned.reduce((maximum, control) => Math.max(maximum, control.consent_revision!), 0);
    const latest = versioned.filter(control => control.consent_revision === revision).sort(order);
    const first = latest[0];
    if (!first && !legacy) return [];
    const selected = first ?? legacy!;
    return [{ processing_purpose_id, consent_revision: revision,
      consent_state: selected.consent_state as Exclude<ConsentState, "unknown">,
      recognized_sequence: selected.recognized_sequence, recognized_at: selected.recognized_at,
      conflicting_revision: new Set(latest.map(control => control.consent_state)).size > 1,
      ...(legacy ? { unversioned_withdrawal_sequence: legacy.recognized_sequence,
        unversioned_withdrawal_at: legacy.recognized_at } : {}),
    }];
  });
}

export type PurposeConsentAdmission = "legacy" | "allowed" | "not_required" | "withdrawn" | "revision_unconfirmed";
/** Return legacy only where no new assertion changes the previous policy. */
export function purposeConsentAdmission(snapshot: PurposeConsentSnapshot | undefined, declaredRevision: number | undefined): PurposeConsentAdmission {
  if (declaredRevision !== undefined && !validSequence(declaredRevision)) return "revision_unconfirmed";
  if (!snapshot) return declaredRevision === undefined || declaredRevision === 0 ? "legacy" : "revision_unconfirmed";
  if (snapshot.conflicting_revision) return "revision_unconfirmed";
  if (stopped(snapshot.consent_state)
    || snapshot.unversioned_withdrawal_sequence !== undefined && snapshot.unversioned_withdrawal_sequence >= snapshot.recognized_sequence) return "withdrawn";
  if (declaredRevision !== snapshot.consent_revision) return "revision_unconfirmed";
  return snapshot.consent_state === "not_required" ? "not_required" : "allowed";
}
