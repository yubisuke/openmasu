import type { OpenMasuAttributionResultV04 } from "./generated/contract-types.js";

/** Trusted server projection, never an SDK/API input or proof of a live provider connection. */
export type PlatformAcquisitionInput = {
  attribution: OpenMasuAttributionResultV04;
  install_record_id: string;
  source: "apple_adservices" | "meta_install_referrer";
  context: { campaign_id?: string; ad_group_id?: string };
  evidence_ref: string;
  evidence_digest: string;
  lifecycle_status: "available" | "redacted" | "purged";
};
