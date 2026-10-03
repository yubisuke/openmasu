import assert from "node:assert/strict";
import { it } from "node:test";
import { importedInstallEvidence } from "./fact-projections.js";

it("projects only canonical declared import context for the same producer", () => {
  const context = {provider:"synthetic-export",provider_attributed:true,provider_attribution_strategy:"click_through",
    provider_campaign_ref:"synthetic-campaign",provider_country:"US",unrelated:"must-not-copy"};
  const {unrelated: _removed,...expected} = context;
  assert.deepEqual(importedInstallEvidence({import_context:context},"import:synthetic-export"),{import_context:expected});
  assert.deepEqual(importedInstallEvidence({import_context:context},"sdk-android"),{});
  assert.deepEqual(importedInstallEvidence({import_context:context},"import:synthetic-second"),{});
  assert.deepEqual(importedInstallEvidence({},"import:synthetic-export"),{});
});
