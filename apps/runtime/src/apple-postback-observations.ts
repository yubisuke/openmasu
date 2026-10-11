/** Closed, non-identifying metadata for observation reports, not a new metric contract. */
export const appleObservationValues = {
  protocol: ["skan_3", "skan_4", "adattributionkit"],
  sequence: ["0", "1", "2", "not_provided"],
  winner: ["winner", "nonwinner", "not_provided"],
  conversion_type: ["download", "redownload", "re-engagement", "not_provided"],
  source_state: ["digits_2", "digits_3", "digits_4", "absent", "not_applicable"],
  conversion_value_state: ["fine", "coarse_low", "coarse_medium", "coarse_high", "absent"],
  conversion_value_coverage: ["unsigned", "not_applicable"],
  verification_reason: ["verified", "signature_invalid", "unknown_key", "development_postback_rejected", "malformed"],
} as const;
export type AppleObservation = { [K in keyof typeof appleObservationValues]: typeof appleObservationValues[K][number] | "not_recorded" };

/** Called after contract validation. Never copy source values, IDs, signatures or arbitrary extensions. */
export function projectApplePostbackObservation(payload: Record<string, unknown>): AppleObservation & { version: 1 } {
  const skan = payload.event_name === "skan_postback";
  const legacySkan = skan && typeof payload.version === "string" && payload.version.startsWith("3.");
  const boundary = payload.extensions as { unsigned_observation_fields?: unknown; apple_verification_reason?: unknown } | undefined;
  const fine = payload.conversion_value !== undefined, coarse = payload.coarse_conversion_value;
  const unsigned = boundary?.unsigned_observation_fields;
  const reason = boundary?.apple_verification_reason;
  return {
    version: 1,
    protocol: skan ? legacySkan ? "skan_3" : "skan_4" : "adattributionkit",
    sequence: payload.postback_sequence_index === undefined ? "not_provided" : String(payload.postback_sequence_index) as "0" | "1" | "2",
    winner: payload.did_win === true ? "winner" : payload.did_win === false ? "nonwinner" : "not_provided",
    conversion_type: skan ? payload.redownload === true ? "redownload" : payload.redownload === false ? "download" : "not_provided"
      : payload.conversion_type as AppleObservation["conversion_type"],
    source_state: legacySkan ? "not_applicable" : typeof payload.source_identifier === "string"
      ? `digits_${payload.source_identifier.length}` as "digits_2" | "digits_3" | "digits_4" : "absent",
    conversion_value_state: fine ? "fine" : coarse === undefined ? "absent" : `coarse_${coarse}` as "coarse_low" | "coarse_medium" | "coarse_high",
    conversion_value_coverage: !fine && coarse === undefined ? "not_applicable"
      : Array.isArray(unsigned) && unsigned.includes(fine ? "conversion-value" : "coarse-conversion-value") ? "unsigned" : "not_recorded",
    verification_reason: payload.signature_verified === true ? "verified"
      : appleObservationValues.verification_reason.includes(reason as never) && reason !== "verified"
        ? reason as AppleObservation["verification_reason"] : "not_recorded",
  };
}
