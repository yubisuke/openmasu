import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalConversionSchema } from "./apple-admin.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseConversionMeaning, meaningUpdate, decodeConversionMeaning } from "./apple-conversion-meaning.js";
import { conversionMeaningBundle, meaningFormValues, parseMeaningForm } from "./apple-meaning-configuration.js";
import { renderMeaningConfiguration, renderMeaningConfigurationForm } from "./dashboard/apple-meaning.js";
import { jcs } from "@openmasu/attribution-core/canonical";

describe("Apple conversion schema registration", () => {
  it("Issue 361 form and exported canonical bytes match the existing parser and Swift digest", () => {
    const {definition}=JSON.parse(readFileSync("sdk/ios/Tests/OpenMasuApplePostbackTests/Vectors/meaning.json","utf8"));
    const form=new URLSearchParams({...meaningFormValues(definition),csrf_token:"synthetic-csrf"});
    const parsed=parseMeaningForm(form), bundle=conversionMeaningBundle(parsed);
    assert.equal(jcs(parsed),jcs(parseConversionMeaning(definition)));
    assert.equal(bundle.canonical_definition,jcs(definition));
    assert.equal(bundle.schema_digest,"1f1d34137531516b47d84f489342966738e4a50d18110e9d3ced2dfc5202b5e0");
    assert.deepEqual(JSON.parse(bundle.canonical_definition),definition);
    const html=renderMeaningConfiguration("app-synthetic",parsed,"synthetic-csrf");
    assert.equal((html.match(/data-fine="\d+"/g)??[]).length,64);
    for(const coarse of ["low","medium","high"]) assert.match(html,new RegExp(`<th scope="row">${coarse}</th>`));
    assert.match(html,/Postback binding: unverified/);assert.match(html,/\[100, 500\) USD/);
    assert.match(html,/Outside this definition/);assert.match(html,/Unreachable: revenue bucket without revenue event/);
    assert.match(html,/Register this exact definition/);assert.doesNotMatch(html,/<script|javascript:|\son\w+=/i);
    const saved=renderMeaningConfiguration("app-synthetic",parsed,undefined,true);
    assert.doesNotMatch(saved,/method="post"/);assert.match(saved,/Download registered SDK configuration/);
    assert.doesNotMatch(renderMeaningConfigurationForm("app-synthetic","csrf",[],false),/method="post"/);
    for(const [name,value] of [["event_keys","one,two,three,four"],["thresholds","0,1,2,3,4,5,6,7,8"],
      ["thresholds","0,100,100"],["thresholds","0,1.5"],["medium_from","4junk"],["effective_to","2026-02-30"],
      ["lock_at_maximum","on"],["extra","synthetic-unsupported"]]) {
      const invalid=new URLSearchParams(form);invalid.set(name,value);assert.throws(()=>parseMeaningForm(invalid),/conversion_meaning/);
    }
    const duplicate=new URLSearchParams(form);duplicate.append("currency","USD");assert.throws(()=>parseMeaningForm(duplicate),/form_invalid/);
  });
  it("canonicalizes object keys deterministically without changing arrays", () => {
    const left = canonicalConversionSchema({
      version: "1.0.0",
      rules: [{ coarse: "low", fine: 1 }],
      enabled: true,
    });
    const right = canonicalConversionSchema({
      enabled: true,
      rules: [{ fine: 1, coarse: "low" }],
      version: "1.0.0",
    });
    assert.equal(left, right);
    assert.equal(left, '{"enabled":true,"rules":[{"coarse":"low","fine":1}],"version":"1.0.0"}');
  });

  it("rejects non-object and non-finite definitions", () => {
    assert.throws(() => canonicalConversionSchema([]), /definition_invalid/);
    assert.throws(() => canonicalConversionSchema({ fine: Number.NaN }), /non_finite_number/);
  });

  it("shares independently calculated event/revenue meaning vectors with the Swift evaluator and preserves coarse ranges", () => {
    const vectors = JSON.parse(readFileSync("sdk/ios/Tests/OpenMasuApplePostbackTests/Vectors/meaning.json", "utf8"));
    const schema = parseConversionMeaning(vectors.definition);
    for (const row of vectors.cases) {
      assert.deepEqual(meaningUpdate(schema, row.mask, BigInt(row.revenue)), { fine_value: row.fine, coarse_value: row.coarse, lock_postback: row.lock }, row.name);
      assert.deepEqual(decodeConversionMeaning(schema, `fine:${row.fine}`, "skan_4", "0", "download"), {
        state: "unverified", reason: "operator_selected_definition_not_postback_bound", possible_meanings: [{ fine_value: row.fine,
          event_keys_observed: row.keys, revenue_range: { lower_inclusive: row.lower, upper_exclusive: row.upper, currency: "USD", amount_scale: 2 } }],
      });
    }
    const coarse = decodeConversionMeaning(schema, "coarse:medium", "adattributionkit", "1", "download");
    assert.deepEqual(coarse.possible_meanings?.map(row => row.fine_value), [6, 7]);
    assert.ok(coarse.possible_meanings?.every(row => row.revenue_range.lower_inclusive === "100" && row.revenue_range.upper_exclusive === "500"));
    for (const [bucket, sequence, type, reason] of [["absent", "0", "download", "value_absent"],
      ["fine:63", "0", "download", "value_outside_definition"], ["fine:4", "0", "download", "value_outside_definition"],
      ["fine:6", "not_recorded", "download", "unsupported_window_or_type"], ["fine:6", "0", "re-engagement", "unsupported_window_or_type"]]) {
      assert.deepEqual(decodeConversionMeaning(schema, bucket, "adattributionkit", sequence, type), { state: "unverified", reason });
    }
  });

  it("validates the closed profile and binds every event and revenue boundary into the registration digest", () => {
    const { definition } = JSON.parse(readFileSync("sdk/ios/Tests/OpenMasuApplePostbackTests/Vectors/meaning.json", "utf8"));
    const hash = (value: unknown) => createHash("sha256").update(canonicalConversionSchema(value)).digest("hex");
    assert.equal(hash(definition), "1f1d34137531516b47d84f489342966738e4a50d18110e9d3ced2dfc5202b5e0", "also pinned by the Swift shared-vector test");
    assert.equal(hash(definition), hash(Object.fromEntries(Object.entries(definition).reverse())));
    assert.notEqual(hash(definition), hash({ ...definition, event_keys: [...definition.event_keys].reverse() }));
    for (const patch of [{ extra: "not_allowed" }, { effective_to: "2026-02-30T00:00:00.000Z" }, { event_keys: ["purchase", "purchase"] },
      { revenue: { ...definition.revenue, thresholds: ["0", "100", "100"] } }, { coarse: { medium_from: 8, high_from: 4 } },
      { revenue: { ...definition.revenue, thresholds: ["0", "1.23"] } }, { revenue: { ...definition.revenue, thresholds: ["0", "100\n"] } }]) {
      assert.throws(() => parseConversionMeaning({ ...definition, ...patch }), /conversion_meaning_invalid/);
    }
  });
});
