import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, it } from "node:test";
import { validateEventPayload } from "@open-mmp/contracts";
import { Ajv2020Module, addFormatsModule, canonicalize } from "@open-mmp/contracts/validation-tooling";
import { evaluate, sha256, TimestampInvalidError } from "@open-mmp/attribution-core";

type Any = Record<string, any>;
type Captured<T> = { ok: true; value: T } | { ok: false; error: unknown };
const root = process.cwd();
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const summaryOnly = process.argv.includes("--summary");

function fail(message: string): never {
  throw new Error(message);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function capture<T>(operation: () => T): Captured<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function capturedValue<T>(captured: Captured<T>, label: string): T {
  if (!captured.ok) {
    const detail = captured.error instanceof Error ? captured.error.message : String(captured.error);
    fail(`${label}: ${detail}`);
  }
  return captured.value;
}

function json(path: string): Any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function equal(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function unique(values: string[], label: string): void {
  check(new Set(values).size === values.length, `duplicate ${label}`);
}

function fixRefs(value: Any): Any {
  if (Array.isArray(value)) return value.map(fixRefs);
  if (!value || typeof value !== "object") return value;
  const output: Any = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = key === "$ref" && typeof child === "string"
      ? child
        .replace("../common.schema.json", "urn:open-mmp:schema:common:v0.3")
        .replace("common.schema.json", "urn:open-mmp:schema:common:v0.3")
      : fixRefs(child as Any);
  }
  return output;
}

function assertClosedObjects(value: Any, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertClosedObjects(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "object" && value.additionalProperties === undefined) {
    fail(`open object without an explicit policy: ${path}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "extensions") assertClosedObjects(child as Any, `${path}.${key}`);
  }
}

const Ajv2020 = Ajv2020Module as unknown as new (options: Any) => {
  addSchema(schema: unknown): void;
  getSchema(id: string): (((value: unknown) => boolean) & { errors?: unknown }) | undefined;
  errorsText(errors: unknown): string;
};
type Validator = NonNullable<ReturnType<InstanceType<typeof Ajv2020>["getSchema"]>>;

type SchemaState = {
  path: string;
  loaded: Captured<Any>;
  id?: string;
  compileError?: unknown;
  validator?: Validator;
};

const schemaPaths = files(join(root, "schemas")).filter((path) => path.endsWith(".json")).sort();
const schemaStates: SchemaState[] = schemaPaths.map((path) => ({ path, loaded: capture(() => json(path)) }));
const schemaValues = schemaStates.flatMap((state) =>
  state.loaded.ok ? [{ path: state.path, value: state.loaded.value }] : [],
);
const schemaIds = schemaValues
  .map(({ value }) => value.$id)
  .filter((value): value is string => typeof value === "string");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: unknown) => void;
addFormats(ajv);
for (const state of schemaStates) {
  if (!state.loaded.ok) continue;
  state.id = typeof state.loaded.value.$id === "string" ? state.loaded.value.$id : undefined;
  try {
    ajv.addSchema(fixRefs(state.loaded.value));
  } catch (error) {
    state.compileError = error;
  }
}
for (const state of schemaStates) {
  if (!state.id || state.compileError) continue;
  try {
    state.validator = ajv.getSchema(state.id);
    if (!state.validator) state.compileError = new Error(`schema did not compile: ${state.id}`);
  } catch (error) {
    state.compileError = error;
  }
}

function validatorFor(id: string): Validator {
  const state = schemaStates.find((candidate) => candidate.id === id);
  check(state, `schema state missing: ${id}`);
  check(!state.compileError, `schema did not compile: ${id}: ${String(state.compileError)}`);
  check(state.validator, `schema validator missing: ${id}`);
  return state.validator;
}

function schemaValue(id: string): Any {
  const state = schemaStates.find((candidate) => candidate.id === id);
  check(state?.loaded.ok, `schema value missing: ${id}`);
  return state.loaded.value;
}

const registryPaths = {
  events: join(root, "registries", "event-names-v0.3.json"),
  reasons: join(root, "registries", "reason-codes-v0.3.json"),
  producers: join(root, "registries", "producer-values-v0.3.json"),
  differences: join(root, "registries", "difference-reasons-v0.3.json"),
  states: join(root, "registries", "state-transitions-v0.3.json"),
  compatibility: join(root, "registries", "compatibility-v0.3.json"),
  matchingKeys: join(root, "registries", "matching-key-types-v0.3.json"),
  processingPurposes: join(root, "registries", "processing-purposes-v0.3.json"),
};
type RegistryName = keyof typeof registryPaths;
const registryStates = Object.fromEntries(
  Object.entries(registryPaths).map(([name, path]) => [name, { path, loaded: capture(() => json(path)) }]),
) as Record<RegistryName, { path: string; loaded: Captured<Any> }>;

function registryValue(name: RegistryName, fallback: Any): Any {
  const loaded = registryStates[name].loaded;
  return loaded.ok ? loaded.value : fallback;
}

const registries = {
  events: registryValue("events", { event_names: [] }),
  reasons: registryValue("reasons", {
    attribution: [], rejection: [], consent_decision: [], correction: [], fraud_public_categories: [],
  }),
  producers: registryValue("producers", { values: [] }),
  differences: registryValue("differences", { reasons: [] }),
  states: registryValue("states", { axes: {} }),
  compatibility: registryValue("compatibility", { attribution: [] }),
  matchingKeys: registryValue("matchingKeys", { types: [] }),
  processingPurposes: registryValue("processingPurposes", { purposes: [] }),
};
const eventNames: string[] = Array.isArray(registries.events.event_names) ? registries.events.event_names : [];
const attributionReasons = new Set<string>(registries.reasons.attribution ?? []);
const rejectionReasons = new Set<string>(registries.reasons.rejection ?? []);
const consentReasons = new Set<string>(registries.reasons.consent_decision ?? []);
const correctionReasons = new Set<string>(registries.reasons.correction ?? []);
const fraudReasons = new Set<string>(registries.reasons.fraud_public_categories ?? []);
const differenceReasons = new Set<string>(registries.differences.reasons ?? []);
const producerValues: string[] = (registries.producers.values ?? []).map((entry: Any) => entry.value);
const producerMatches = (registered: string, value: string) => {
  if (registered === value) return true;
  if (registered === "import:<provider>") return /^import:[a-z0-9-]+$/.test(value);
  if (registered === "adapter:<network>") return /^adapter:[a-z0-9-]+$/.test(value);
  if (registered === "postback:<kind>") return /^postback:[a-z0-9-]+$/.test(value);
  return false;
};
const producerAllowed = (value: string) => producerValues.some((registered) => producerMatches(registered, value));

function validateSyntheticImportContext(context: Any, label: string): void {
  check(context.provider.startsWith("synthetic-"), `non-synthetic provider alias in public fixture: ${label}`);
  if (context.provider_network !== undefined) {
    check(context.provider_network.startsWith("synthetic-"), `non-synthetic network alias in public fixture: ${label}`);
  }
  for (const field of [
    "provider_install_ref", "provider_click_ref", "provider_campaign_ref",
    "provider_adgroup_ref", "provider_creative_ref", "provider_site_ref",
  ]) {
    if (context[field] !== undefined) {
      check(/^(provider|synthetic)-/.test(context[field]), `non-synthetic provider reference in public fixture: ${label}.${field}`);
    }
  }
}
const matchingDefinitions = new Map<string, Any>((registries.matchingKeys.types ?? []).map((entry: Any) => [entry.type, entry]));
const stateAxes = registries.states.axes ?? {};
const compatibility = registries.compatibility.attribution ?? [];
const processingPurposeIds: string[] = (registries.processingPurposes.purposes ?? [])
  .map((entry: Any) => entry.processing_purpose_id);
const processingPurposeSet = new Set<string>(processingPurposeIds);

const outputSchemaIds: Record<string, string> = {
  raw_records: "urn:open-mmp:schema:raw-record:v0.3",
  deliveries: "urn:open-mmp:schema:event-delivery:v0.3",
  logical_events: "urn:open-mmp:schema:logical-event:v0.3",
  corrections: "urn:open-mmp:schema:correction:v0.3",
  privacy_requests: "urn:open-mmp:schema:privacy-request:v0.3",
  privacy_tombstones: "urn:open-mmp:schema:privacy-tombstone:v0.3",
  attributions: "urn:open-mmp:schema:attribution-result:v0.3",
  cost_records: "urn:open-mmp:schema:cost-record:v0.3",
  metric_definitions: "urn:open-mmp:schema:metric-definition:v0.3",
  metric_runs: "urn:open-mmp:schema:metric-run:v0.3",
  fraud_decisions: "urn:open-mmp:schema:fraud-decision:v0.3",
  rejections: "urn:open-mmp:schema:rejection:v0.3",
  reconciliation: "urn:open-mmp:schema:reconciliation-result:v0.3",
};
const expectedFiles: Record<string, string> = Object.fromEntries(
  Object.keys(outputSchemaIds).map((name) => [name, `expected_${name}.json`]),
);

function fixtureAttempts(input: Any): Any[] {
  if (input.batches) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({ server: batch.server_context, record })),
    );
  }
  return (input.records ?? []).map((record: Any) => ({ server: input.server_context, record }));
}

function reorderedInput(input: Any): Any {
  const reordered = structuredClone(input);
  if (reordered.records) reordered.records.reverse();
  if (reordered.batches) {
    reordered.batches.reverse();
    for (const batch of reordered.batches) batch.records.reverse();
  }
  return reordered;
}

type PythonBatchResult =
  | { ok: true; output: Any }
  | { ok: false; error: { name: string; message: string; exit_code: number } };

function pythonBatch(inputs: Any[]): PythonBatchResult[] {
  return JSON.parse(execFileSync("python", [join(root, "tools", "python_evaluator.py"), "--batch"], {
    input: JSON.stringify(inputs),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }));
}

function pythonOutputs(inputs: Any[]): Any[] {
  return pythonBatch(inputs).map((result, index) => {
    if (!result.ok) fail(`Python batch item ${index} failed: ${result.error.message}`);
    return result.output;
  });
}

function validateMatchingKey(value: Any, label: string): void {
  const definition = matchingDefinitions.get(value.type);
  check(definition, `unknown matching key in ${label}: ${value.type}`);
  for (const field of ["scope", "normalization", "cardinality", "protected", "value_encoding", "access_class"]) {
    if (definition[field] === undefined) continue;
    check(value[field] === definition[field], `matching-key metadata mismatch in ${label}: ${value.type}.${field}`);
  }
  if (["provider_install_id", "provider_click_id"].includes(value.type)) {
    check(/^[a-f0-9]{64}$/.test(value.value), `provider matching key is not a SHA-256 digest in ${label}`);
    check(value.value_encoding === "sha256" && value.access_class === "protected", `provider matching key classification mismatch in ${label}`);
  }
}

function validateRegistryReferences(output: Any, label: string): void {
  for (const record of output.raw_records) {
    check(eventNames.includes(record.event_name), `unknown raw event_name in ${label}`);
    check(producerAllowed(record.producer), `unknown producer in ${label}`);
    check(consentReasons.has(record.consent_decision_reason_code), `unknown raw consent reason in ${label}`);
  }
  for (const delivery of output.deliveries) {
    check(consentReasons.has(delivery.consent_decision_reason_code), `unknown delivery consent reason in ${label}`);
    if (delivery.reason_code) check(rejectionReasons.has(delivery.reason_code), `unknown delivery reason in ${label}`);
  }
  for (const event of output.logical_events) check(eventNames.includes(event.event_name), `unknown logical event in ${label}`);
  for (const correction of output.corrections) check(correctionReasons.has(correction.correction_reason), `unknown correction reason in ${label}`);
  for (const attribution of output.attributions) {
    check(attributionReasons.has(attribution.reason_code), `unknown attribution reason in ${label}`);
    const compatible = compatibility.some((row: Any) =>
      row.subject_scope === attribution.subject_scope && row.method === attribution.method &&
      row.model === attribution.model && row.statuses.includes(attribution.status),
    );
    check(compatible, `incompatible attribution tuple in ${label}`);
    for (const evidence of attribution.evidence_refs) {
      check(evidence.tenant_id === attribution.tenant_id && evidence.app_id === attribution.app_id, `cross-scope attribution evidence in ${label}`);
    }
  }
  for (const run of output.metric_runs) {
    for (const evidence of run.evidence_refs) {
      check(typeof evidence.tenant_id === "string" && typeof evidence.app_id === "string", `unqualified metric evidence in ${label}`);
    }
  }
  for (const cost of output.cost_records) {
    const dimensions = Object.fromEntries(
      ["network", "campaign_id", "ad_group_id", "country"]
        .filter((field) => cost[field] !== undefined)
        .map((field) => [field, cost[field]]),
    );
    check(cost.dimension_digest === sha256(dimensions), `cost dimension digest mismatch in ${label}`);
  }
  for (const definition of output.metric_definitions) {
    const aggregateMetricNames = new Set([
      "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
    ]);
    const expectedVersion = aggregateMetricNames.has(definition.metric_name)
      ? "0.3.3"
      : definition.definition.calculation === "event_count" ? "0.3.1" : "0.3.0";
    check(definition.metric_definition_version === expectedVersion, `wrong metric definition version in ${label}`);
    check(["UTC", "Asia/Tokyo"].includes(definition.aggregation_time_zone), `unknown metric definition time zone in ${label}`);
  }
  for (const rejection of output.rejections) {
    check(rejectionReasons.has(rejection.reason_code), `unknown rejection reason in ${label}`);
    check(consentReasons.has(rejection.consent_decision_reason_code), `unknown rejection consent reason in ${label}`);
  }
  for (const fraud of output.fraud_decisions) check(fraudReasons.has(fraud.reason_code), `unknown fraud reason in ${label}`);
  for (const result of output.reconciliation) {
    check(differenceReasons.has(result.difference_reason_code), `unknown difference reason in ${label}`);
    result.matching_keys.forEach((entry: Any) => validateMatchingKey(entry, label));
  }
}

const fixtureRoot = join(root, "fixtures", "v0.3");
const fixtureDirs = readdirSync(fixtureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(fixtureRoot, entry.name))
  .sort();
type FixtureState = {
  dir: string;
  name: string;
  input: Captured<Any>;
  expectedParts: Record<string, Captured<Any>>;
  expected: Captured<Any>;
  first: Captured<Any>;
  second: Captured<Any>;
  reordered: Captured<Any>;
  python?: PythonBatchResult;
};

const fixtureStates: FixtureState[] = fixtureDirs.map((dir) => {
  const name = basename(dir);
  const input = capture(() => json(join(dir, "input.json")));
  const expectedParts = Object.fromEntries(
    Object.entries(expectedFiles).map(([kind, fileName]) => [kind, capture(() => json(join(dir, fileName)))]),
  );
  const expected = capture(() => Object.fromEntries(
    Object.entries(expectedParts).map(([kind, loaded]) => [kind, capturedValue(loaded, `${name}/${expectedFiles[kind]}`)]),
  ));
  const first = input.ok ? capture(() => evaluate(input.value)) : { ok: false as const, error: input.error };
  const second = input.ok
    ? capture(() => evaluate(JSON.parse(JSON.stringify(input.value))))
    : { ok: false as const, error: input.error };
  const reordered = input.ok
    ? capture(() => evaluate(reorderedInput(input.value)))
    : { ok: false as const, error: input.error };
  return { dir, name, input, expectedParts, expected, first, second, reordered };
});

const outputArtifactCount = fixtureStates.reduce(
  (count, state) => count + Object.values(state.expectedParts).filter((loaded) => loaded.ok).length,
  0,
);
const pythonFixtureStates = fixtureStates.filter((state) => state.input.ok);
const fixturePythonBatch = capture(() => pythonBatch(
  pythonFixtureStates.map((state) => capturedValue(state.input, `${state.name}/input.json`)),
));
if (fixturePythonBatch.ok) {
  fixturePythonBatch.value.forEach((result, index) => {
    const state = pythonFixtureStates[index];
    if (state) state.python = result;
  });
}

const results = new Map<string, { input: Any; output: Any; python: Any }>();
for (const state of fixtureStates) {
  if (!state.input.ok || !state.first.ok || !state.python?.ok) continue;
  results.set(state.name, { input: state.input.value, output: state.first.value, python: state.python.output });
}

function fixture(name: string): { input: Any; output: Any; python: Any } {
  const value = results.get(name);
  check(value, `missing fixture result: ${name}`);
  return value;
}

// Real-data guardrails. This repository is public and every fixture is synthetic.
// Tabular exports (CSV/TSV/XLSX/XLS/Parquet) and lab/input directories must never
// be committed. The check covers tracked files plus untracked files that git would
// accept on `git add` (ignored files are excluded on purpose). If a future importer
// needs a synthetic CSV fixture, allow-list its exact path in .gitignore and in
// FORBIDDEN_TABULAR_ALLOWLIST below in the same change.
const FORBIDDEN_TABULAR_EXTENSIONS = /\.(csv|tsv|xlsx|xls|parquet)$/i;
const FORBIDDEN_TABULAR_ALLOWLIST: string[] = [];
const FORBIDDEN_DIRECTORY_SEGMENTS = /(^|\/)(open-mmp-lab|real-data|input)(\/|$)/;

function gitListedFiles(): string[] {
  const listed = (args: string[]) =>
    execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((entry) => entry.length > 0);
  const tracked = listed([]);
  const untrackedNotIgnored = listed(["--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untrackedNotIgnored])].sort();
}

if (!summaryOnly) {
  describe("real-data guardrails", () => {
    const files = gitListedFiles();
    it("lists files through git", () => {
      check(files.length > 0, "git ls-files returned no files; guardrail cannot run");
    });
    it("contains no tabular export files", () => {
      const offenders = files.filter(
        (file) => FORBIDDEN_TABULAR_EXTENSIONS.test(file) && !FORBIDDEN_TABULAR_ALLOWLIST.includes(file),
      );
      check(offenders.length === 0, `tabular files are not allowed in this repository: ${offenders.join(", ")}`);
    });
    it("contains no lab, real-data, or input directories", () => {
      const offenders = files.filter((file) => FORBIDDEN_DIRECTORY_SEGMENTS.test(file));
      check(offenders.length === 0, `forbidden directory segment: ${offenders.join(", ")}`);
    });
    it("keeps fixtures limited to JSON and README files", () => {
      const offenders = files.filter(
        (file) => file.startsWith("fixtures/") && !/\.json$/.test(file) && !/(^|\/)README\.md$/.test(file),
      );
      check(offenders.length === 0, `fixtures/ may only contain .json and README.md: ${offenders.join(", ")}`);
    });
  });

  describe("schema health", () => {
    for (const state of schemaStates) {
      it(relative(root, state.path), () => {
        const value = capturedValue(state.loaded, `schema load failure: ${relative(root, state.path)}`);
        check(value.$schema === DRAFT, `wrong schema dialect: ${relative(root, state.path)}`);
        check(/^urn:open-mmp:schema:[a-z0-9-]+:v0\.3$/.test(value.$id), `unstable schema id: ${relative(root, state.path)}`);
        assertClosedObjects(value, relative(root, state.path));
        check(!state.compileError, `schema did not compile: ${value.$id}: ${String(state.compileError)}`);
        check(state.validator, `schema validator missing: ${value.$id}`);
      });
    }
    it("contains unique schema identifiers", () => unique(schemaIds, "schema $id"));
  });

  describe("registry health", () => {
    for (const name of Object.keys(registryPaths) as RegistryName[]) {
      it(name, () => {
        const value = capturedValue(registryStates[name].loaded, `registry load failure: ${name}`);
        const expectedVersion = name === "differences" ? "0.3.0" : "0.3.0";
        check(value.contract_version === expectedVersion, `registry version: ${name}`);
        if (name === "events") {
          unique(value.event_names, "event name");
          check(value.event_names.length === 12, "event-name registry must contain the twelve Contract v0.3 events");
        } else if (name === "reasons") {
          for (const [reasonName, values] of Object.entries(value).filter(([key]) => key !== "contract_version")) {
            if (Array.isArray(values)) unique(values, `reason code in ${reasonName}`);
          }
        } else if (name === "producers") {
          unique(value.values.map((entry: Any) => entry.value), "producer");
        } else if (name === "differences") {
          unique(value.reasons, "difference reason");
        } else if (name === "matchingKeys") {
          unique(value.types.map((entry: Any) => entry.type), "matching-key type");
        } else if (name === "processingPurposes") {
          check(typeof value.legal_notice === "string" && value.legal_notice.length > 0, "processing-purpose legal notice missing");
          unique(value.purposes.map((entry: Any) => entry.processing_purpose_id), "processing-purpose ID");
          check(equal(value.purposes.map((entry: Any) => entry.processing_purpose_id), [
            "attribution", "fraud_prevention", "analytics", "revenue_measurement",
          ]), "processing-purpose inventory mismatch");
          for (const purpose of value.purposes) {
            check(typeof purpose.meaning === "string" && purpose.meaning.length > 0, `processing-purpose meaning: ${purpose.processing_purpose_id}`);
            check(typeof purpose.default_consent_required === "boolean", `processing-purpose consent default: ${purpose.processing_purpose_id}`);
            check(["consent", "legitimate_interests"].includes(purpose.assumed_legal_basis_category), `processing-purpose legal-basis category: ${purpose.processing_purpose_id}`);
            check(purpose.deployment_override_allowed === true, `processing-purpose override: ${purpose.processing_purpose_id}`);
          }
        } else if (name === "compatibility") {
          unique(value.attribution.map((entry: Any) => `${entry.subject_scope}|${entry.method}|${entry.model}`), "attribution compatibility row");
        } else if (name === "states") {
          for (const axis of ["ingestion", "duplicate_resolution", "timeliness", "record_lifecycle", "payload_availability", "attribution_finality", "privacy_request"]) {
            check(value.axes[axis], `missing state axis: ${axis}`);
            unique(value.axes[axis].states, `state in ${axis}`);
            const states = new Set<string>(value.axes[axis].states);
            const edges = value.axes[axis].transitions.map((edge: string[]) => edge.join("->"));
            unique(edges, `transition in ${axis}`);
            for (const edge of value.axes[axis].transitions) {
              check(edge.length === 2 && states.has(edge[0]) && states.has(edge[1]), `invalid transition endpoint in ${axis}`);
            }
            for (const terminal of value.axes[axis].terminal) {
              check(states.has(terminal), `invalid terminal state in ${axis}`);
            }
          }
        }
      });
    }
    it("keeps registry reason sets equal to schema enums", () => {
      const surfaces: Array<[string, unknown, unknown]> = [
        ["attribution", registries.reasons.attribution, schemaValue(outputSchemaIds.attributions).properties.reason_code.enum],
        ["rejection", registries.reasons.rejection, schemaValue(outputSchemaIds.rejections).properties.reason_code.enum],
        ["delivery rejection", registries.reasons.rejection, schemaValue(outputSchemaIds.deliveries).properties.reason_code.enum],
        ["correction", registries.reasons.correction, schemaValue(outputSchemaIds.corrections).properties.correction_reason.enum],
        ["consent delivery", registries.reasons.consent_decision, schemaValue(outputSchemaIds.deliveries).properties.consent_decision_reason_code.enum],
        ["consent raw", registries.reasons.consent_decision, schemaValue(outputSchemaIds.raw_records).properties.consent_decision_reason_code.enum],
        ["fraud", registries.reasons.fraud_public_categories, schemaValue(outputSchemaIds.fraud_decisions).properties.reason_code.enum],
        ["difference", registries.differences.reasons, schemaValue(outputSchemaIds.reconciliation).properties.difference_reason_code.enum],
      ];
      for (const [label, registrySet, schemaEnum] of surfaces) {
        check(equal(registrySet, schemaEnum), `registry/schema reason mismatch: ${label}`);
      }
    });
    it("keeps lifecycle state sets equal to schema enums", () => {
      const logical = schemaValue(outputSchemaIds.logical_events).properties.record_lifecycle.enum;
      const raw = schemaValue(outputSchemaIds.raw_records).properties.payload_lifecycle_status.enum;
      const evidence = schemaValue("urn:open-mmp:schema:common:v0.3").$defs.evidenceRef.properties.lifecycle_status.enum;
      check(equal(stateAxes.record_lifecycle.states, logical), "record lifecycle registry/schema mismatch");
      check(equal(stateAxes.payload_availability.states, raw), "raw payload availability registry/schema mismatch");
      check(equal(stateAxes.payload_availability.states, evidence), "evidence payload availability registry/schema mismatch");
    });
    it("keeps processing-purpose registry and schema enum equal", () => {
      const purposeEnum = schemaValue("urn:open-mmp:schema:common:v0.3").$defs.processingPurposeId.enum;
      check(equal(processingPurposeIds, purposeEnum), "processing-purpose registry/schema mismatch");
    });
  });

  describe("fixture input validation", () => {
    for (const state of fixtureStates) {
      it(state.name, () => {
        const input = capturedValue(state.input, `fixture input load failure: ${state.name}`);
        const fixtureValidator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
        check(fixtureValidator(input), `fixture schema failure: ${state.name}: ${ajv.errorsText(fixtureValidator.errors)}`);
        for (const attempt of fixtureAttempts(input)) {
          const record = attempt.record;
          check(eventNames.includes(record.event_name), `unknown fixture event_name: ${state.name}`);
          check(producerAllowed(record.producer), `unknown fixture producer: ${state.name}`);
          const validation = validateEventPayload(record.event_name, record.payload);
          check(validation.valid, `event schema failure: ${state.name}/${record.record_id}: ${validation.fields.join(",")}`);
        }
        for (const item of input.reconciliation_inputs ?? []) {
          item.matching_keys.forEach((entry: Any) => validateMatchingKey(entry, state.name));
          item.candidates.flatMap((candidate: Any) => candidate.matching_keys)
            .forEach((entry: Any) => validateMatchingKey(entry, state.name));
        }
      });
    }
    it("contains 47 fixture directories", () => {
      check(fixtureDirs.length === 47, `expected 47 fixture directories, found ${fixtureDirs.length}`);
    });
  });

  describe("fixture golden schemas", () => {
    for (const state of fixtureStates) {
      it(state.name, () => {
        const expected = capturedValue(state.expected, `golden load failure: ${state.name}`);
        for (const [kind, items] of Object.entries(expected)) {
          const validator = validatorFor(outputSchemaIds[kind]);
          for (const item of items as Any[]) {
            check(validator(item), `${kind} schema failure: ${state.name}: ${ajv.errorsText(validator.errors)}`);
          }
        }
        validateRegistryReferences(expected, state.name);
      });
    }
  });

  describe("fixture TypeScript determinism", () => {
    for (const state of fixtureStates) {
      it(state.name, () => {
        const first = capturedValue(state.first, `TypeScript evaluation failure: ${state.name}`);
        const second = capturedValue(state.second, `second TypeScript evaluation failure: ${state.name}`);
        const reordered = capturedValue(state.reordered, `reordered TypeScript evaluation failure: ${state.name}`);
        check(equal(first, second), `nondeterministic TypeScript output: ${state.name}`);
        check(equal(first, reordered), `input reorder changed semantic output: ${state.name}`);
      });
    }
  });

  describe("fixture reviewed golden comparison", () => {
    for (const state of fixtureStates) {
      it(state.name, () => {
        const first = capturedValue(state.first, `TypeScript evaluation failure: ${state.name}`);
        const expected = capturedValue(state.expected, `golden load failure: ${state.name}`);
        check(equal(first, expected), `reviewed golden mismatch: ${state.name}`);
      });
    }
  });

  describe("fixture TypeScript and Python parity", () => {
    for (const state of fixtureStates) {
      it(state.name, () => {
        const first = capturedValue(state.first, `TypeScript evaluation failure: ${state.name}`);
        check(fixturePythonBatch.ok, "Python fixture batch failed");
        check(state.python, `Python fixture result missing: ${state.name}`);
        check(state.python.ok, `Python fixture failed: ${state.name}`);
        check(equal(first, state.python.output), `cross-language mismatch: ${state.name}`);
      });
    }
  });
}

const scenarios: Array<[string, () => void]> = [
  ["01 valid Install Referrer", () => {
    const value = fixture("01-valid-install-referrer").output;
    check(value.attributions[0].status === "non_organic" && value.reconciliation[0].difference_reason_code === "matched", "scenario 01");
  }],
  ["02 organic no referrer", () => {
    const attr = fixture("02-organic-no-referrer").output.attributions[0];
    check(attr.status === "organic" && attr.reason_code === "no_first_party_referrer", "scenario 02");
  }],
  ["03 unknown click", () => {
    const value = fixture("03-unknown-click").output;
    check(value.attributions[0].status === "unattributed" && value.attributions[0].reason_code === "unknown_click_id", "scenario 03 attribution");
    const reasons = new Set(value.reconciliation.map((item: Any) => item.difference_reason_code));
    check(reasons.has("candidate_missing") && reasons.has("external_row_unmatched"), "scenario 03 reconciliation");
  }],
  ["04 seven-day half-open boundary", () => {
    const attrs = Object.fromEntries(fixture("04-seven-day-boundaries").output.attributions.map((item: Any) => [item.attribution_id, item]));
    check(attrs["attr:install-before"].reason_code === "valid_install_referrer", "scenario 04 before");
    check(attrs["attr:install-exact"].reason_code === "window_expired", "scenario 04 exact");
    check(attrs["attr:install-after"].reason_code === "window_expired", "scenario 04 after");
  }],
  ["05 duplicate delivery", () => {
    const value = fixture("05-duplicate-delivery").output;
    check(value.raw_records.length === 1 && value.logical_events.length === 1 && value.deliveries.length === 2, "scenario 05 artifact counts");
    check(value.deliveries.some((item: Any) => item.duplicate_resolution === "duplicate_delivery"), "scenario 05 duplicate state");
  }],
  ["06 event-ID conflict", () => {
    const value = fixture("06-event-id-conflict").output;
    check(value.raw_records.length === 2 && value.logical_events.length === 1 && value.rejections.some((item: Any) => item.reason_code === "event_id_conflict" && item.retained === "protected_conflict_evidence"), "scenario 06");
  }],
  ["07 same ID across tenants", () => {
    const value = fixture("07-same-id-across-tenants").output;
    const shared = value.raw_records.filter((item: Any) => item.event_id === "shared-event-id");
    check(shared.length === 2 && new Set(shared.map((item: Any) => item.tenant_id)).size === 2, "scenario 07 independent tenants");
    check(value.rejections.some((item: Any) => item.record_id === "tenant-mismatch" && item.reason_code === "client_scope_mismatch"), "scenario 07 mismatch");
  }],
  ["08 late revenue and recalculation", () => {
    const { input, output } = fixture("08-late-ad-revenue");
    const initial = output.metric_runs.filter((item: Any) => item.metric_run_id.startsWith("run-08-initial"));
    const recalculated = output.metric_runs.filter((item: Any) => item.metric_run_id.startsWith("run-08-recalculated"));
    check(initial.length === 3 && initial.every((item: Any) => item.value_unscaled === "0"), "scenario 08 initial");
    check(recalculated.length === 3 && recalculated.every((item: Any) => item.supersedes_metric_run_id && item.value_unscaled !== "0"), "scenario 08 recalculation");
    check(input.records[1].payload.amount_unscaled === "123456789012345678" && input.records[1].payload.amount_scale === 18, "scenario 08 precision");
  }],
  ["09 UTC and JST calendar boundaries", () => {
    const metrics = fixture("09-utc-jst-calendar").output.metric_runs;
    check(metrics.find((item: Any) => item.metric_name.includes("_utc_")).value_unscaled === "0", "scenario 09 UTC");
    check(metrics.find((item: Any) => item.metric_name.includes("_jst_")).value_unscaled === "1000000", "scenario 09 JST");
    check(metrics.find((item: Any) => item.metric_name.includes("_24h_")).value_unscaled === "1000000", "scenario 09 24h");
  }],
  ["10 reinstall classification", () => {
    const attrs = Object.fromEntries(fixture("10-reinstall-redownload").output.attributions.map((item: Any) => [item.attribution_id, item]));
    check(attrs["attr:install-10b"].status === "non_organic" && attrs["attr:install-10b"].reason_code === "valid_install_referrer", "scenario 10 paid reinstall");
    check(attrs["attr:install-10c"].status === "organic" && attrs["attr:install-10c"].reason_code === "no_referrer", "scenario 10 no-referrer redownload");
  }],
  ["11 client clock skew", () => {
    const deliveries = Object.fromEntries(fixture("11-clock-skew").output.deliveries.map((item: Any) => [item.record_id, item]));
    check(deliveries["skew-exact"].clock_skew_suspected === false && deliveries["skew-over"].clock_skew_suspected === true, "scenario 11");
  }],
  ["12 authoritative server time", () => {
    const attrs = Object.fromEntries(fixture("12-authoritative-time").output.attributions.map((item: Any) => [item.attribution_id, item]));
    check(attrs["attr:install-device-cross"].reason_code === "valid_install_referrer", "scenario 12 device evidence");
    check(attrs["attr:install-missing-authority"].reason_code === "authoritative_time_missing", "scenario 12 missing");
    check(attrs["attr:install-invalid-authority"].reason_code === "authoritative_time_invalid", "scenario 12 invalid");
  }],
  ["13 unsupported referrer", () => {
    const reasons = new Set(fixture("13-referrer-unsupported").output.attributions.map((item: Any) => item.reason_code));
    check(reasons.has("install_referrer_unsupported") && reasons.has("install_referrer_unavailable"), "scenario 13");
  }],
  ["14 queued event after withdrawal", () => {
    const value = fixture("14-withdrawal-after-occurrence").output;
    check(value.rejections.some((item: Any) => item.record_id === "queued-before-withdrawal" && item.withdrawal_recognized_at), "scenario 14 default reject");
    check(value.raw_records.some((item: Any) => item.record_id === "queued-explicit-basis" && item.alternative_legal_basis_id === "basis-queued"), "scenario 14 configured basis");
    check(!value.raw_records.some((item: Any) => item.record_id === "queued-before-withdrawal"), "scenario 14 payload discard");
  }],
  ["15 post-withdrawal event and control", () => {
    const value = fixture("15-event-after-withdrawal").output;
    check(value.rejections.some((item: Any) => item.record_id === "event-after-withdrawal"), "scenario 15 reject");
    check(value.raw_records.some((item: Any) => item.record_id === "consent-control-after-withdrawal"), "scenario 15 control");
  }],
  ["16 out-of-order refund correction", () => {
    const corrections = fixture("16-correction-refund").output.corrections;
    check(corrections.some((item: Any) => item.corrects_record_id === "purchase-16" && item.correction_reason === "refund"), "scenario 16 refund");
    check(corrections.some((item: Any) => item.corrects_record_id === "purchase-16" && item.correction_type === "retraction"), "scenario 16 retraction");
  }],
  ["17 redaction and recalculation", () => {
    const value = fixture("17-redaction-recalculation").output;
    check(value.privacy_tombstones.length === 2 && value.corrections.length === 2, "scenario 17 causal artifacts");
    check(!value.raw_records.some((item: Any) => ["revenue-17", "session-purge-17"].includes(item.record_id)) && !value.logical_events.some((item: Any) => ["revenue-17", "session-purge-17"].includes(item.record_id)), "scenario 17 retained evidence removal");
    const after = value.metric_runs.filter((item: Any) => item.metric_run_id.startsWith("run-17-after"));
    check(after.length === 3 && after.every((item: Any) => item.supersedes_metric_run_id && item.reproducibility_status === "redaction_affected"), "scenario 17 replacement runs");
    check(after.some((item: Any) => item.evidence_refs.some((ref: Any) => ref.lifecycle_status === "redacted")) && after.some((item: Any) => item.evidence_refs.some((ref: Any) => ref.lifecycle_status === "purged")), "scenario 17 evidence lifecycle");
    check(value.reconciliation[0].difference_reason_code === "redaction_caused_recalculation", "scenario 17 reconciliation");
  }],
  ["18 aggregate-installation rejection", () => {
    const value = fixture("18-aggregate-installation-rejection").output;
    check(value.rejections[0].reason_code === "aggregate_installation_join_forbidden" && value.raw_records.length === 0, "scenario 18");
  }],
  ["19 bot-prefetch public category", () => {
    const value = fixture("19-bot-prefetch").output;
    check(value.attributions[0].reason_code === "bot_prefetch" && value.fraud_decisions[0].reason_code === "bot_prefetch", "scenario 19 classification");
    check(value.reconciliation[0].difference_reason_code === "candidate_excluded", "scenario 19 reconciliation");
  }],
  ["20 calendar-invalid ingestion timestamp", () => {
    const value = fixture("20-timestamp-invalid").output;
    check(value.deliveries.length === 1 && value.deliveries[0].reason_code === "timestamp_invalid", "scenario 20 delivery");
    check(value.rejections.length === 1 && value.rejections[0].reason_code === "timestamp_invalid", "scenario 20 rejection");
    check(value.rejections[0].payload_disposition === "discarded" && value.rejections[0].retained === "non_identifying_metadata", "scenario 20 disposition");
    check(value.raw_records.length === 0 && value.logical_events.length === 0 && value.attributions.length === 0, "scenario 20 no derived evidence");
  }],
  ["21 reconciliation window mismatch", () => {
    check(fixture("21-reconciliation-window-mismatch").output.reconciliation[0].difference_reason_code === "window_mismatch", "scenario 21");
  }],
  ["22 reconciliation join key missing", () => {
    check(fixture("22-reconciliation-join-key-missing").output.reconciliation[0].difference_reason_code === "join_key_missing", "scenario 22");
  }],
  ["23 reconciliation freshness mismatch", () => {
    check(fixture("23-reconciliation-freshness-mismatch").output.reconciliation[0].difference_reason_code === "freshness_mismatch", "scenario 23");
  }],
  ["24 attribution supersession after redaction", () => {
    const value = fixture("24-attribution-supersession").output;
    const attribution = value.attributions[0];
    check(attribution.finality === "superseded" && attribution.supersedes_attribution_id === "attr:install-24", "scenario 24 supersession");
    check(attribution.attribution_id === "attr:install-24:recalculated" && attribution.evidence_refs.some((entry: Any) => entry.ref === "click-24" && entry.lifecycle_status === "redacted"), "scenario 24 evidence");
  }],
  ["25 replay suspected fraud path", () => {
    const value = fixture("25-replay-suspected").output;
    check(value.fraud_decisions.length === 1 && value.fraud_decisions[0].reason_code === "replay_suspected", "scenario 25 fraud");
    check(value.deliveries[0].duplicate_resolution === "unique" && value.rejections.length === 0, "scenario 25 not transport duplicate");
  }],
  ["26 retention-affected recalculation", () => {
    const value = fixture("26-retention-affected").output;
    const after = value.metric_runs.filter((item: Any) => item.metric_run_id.startsWith("run-26-after"));
    check(after.length === 3 && after.every((item: Any) => item.reproducibility_status === "retention_affected" && item.supersedes_metric_run_id), "scenario 26 metrics");
    check(value.privacy_requests.length === 0 && value.privacy_tombstones.length === 0, "scenario 26 no privacy request");
  }],
  ["27 ad impression revenue linkage", () => {
    const value = fixture("27-ad-impression-revenue-link");
    const impression = value.input.records.find((item: Any) => item.event_name === "ad_impression");
    const revenue = value.input.records.find((item: Any) => item.event_name === "ad_revenue");
    check(impression.payload.impression_id === revenue.payload.impression_id, "scenario 27 impression link");
    check(value.output.raw_records.length === 3 && value.output.metric_runs.every((item: Any) => item.value_unscaled === "3000000"), "scenario 27 outputs");
  }],
  ["28 imported provider-attributed install", () => {
    const value = fixture("28-imported-provider-attributed").output;
    const attribution = value.attributions[0];
    check(attribution.status === "non_organic" && attribution.method === "imported" && attribution.model === "provider_reported" && attribution.reason_code === "provider_attributed", "scenario 28 attribution");
    check(value.reconciliation.length === 1 && value.reconciliation[0].difference_reason_code === "matched", "scenario 28 reconciliation");
  }],
  ["29 imported provider-organic install", () => {
    const value = fixture("29-imported-provider-organic").output;
    check(value.attributions[0].status === "organic" && value.attributions[0].reason_code === "provider_organic", "scenario 29 attribution");
    check(value.raw_records.some((record: Any) => record.producer === "sdk-ios"), "scenario 29 sdk-ios producer");
  }],
  ["30 imported attribution without provider time authority", () => {
    const value = fixture("30-imported-time-authority-unavailable").output;
    check(value.attributions[0].status === "non_organic" && value.attributions[0].reason_code === "provider_time_authority_unavailable", "scenario 30 attribution");
    check(value.raw_records.some((record: Any) => record.producer === "postback:synthetic-kind"), "scenario 30 postback producer");
  }],
  ["31 imported reconciliation is derived from records", () => {
    const value = fixture("31-imported-reconciliation-derived");
    const reasons = new Set(value.output.attributions.map((item: Any) => item.reason_code));
    const differences = new Set(value.output.reconciliation.map((item: Any) => item.difference_reason_code));
    check(value.input.reconciliation_inputs.length === 0 && differences.has("matched") && differences.has("join_key_missing"), "scenario 31 automatic reconciliation");
    check(reasons.has("provider_modeled_conversion") && reasons.has("provider_unattributed"), "scenario 31 attribution reasons");
    check(value.output.raw_records.some((record: Any) => record.producer === "adapter:synthetic-network"), "scenario 31 adapter producer");
  }],
  ["32 calendar-valid evidence older than the configured threshold", () => {
    const value = fixture("32-timestamp-stale").output;
    check(value.rejections.length === 1 && value.rejections[0].reason_code === "timestamp_stale", "scenario 32 stale rejection");
    check(value.raw_records.length === 0 && value.logical_events.length === 0, "scenario 32 payload discarded");
  }],
  ["33 Stage B cohort dimensions cost and metrics", () => {
    const value = fixture("33-stage-b-cohort-metrics");
    const metrics = Object.fromEntries(value.output.metric_runs
      .filter((item: Any) => item.metric_run_id.startsWith("run-33:"))
      .map((item: Any) => [item.metric_name, item]));
    check(metrics.d1_roas.value_unscaled === "500000" && metrics.d3_roas.value_unscaled === "1000000" && metrics.d7_roas.value_unscaled === "1500000", "scenario 33 ROAS");
    check(metrics.retention_d1.value_unscaled === "1000000" && metrics.retention_d7.value_unscaled === "1000000", "scenario 33 retention");
    check(metrics.cohort_ltv_d7_usd.value_unscaled === "150000000" && metrics.cohort_install_count.value_unscaled === "1", "scenario 33 LTV and count");
  }],
  ["34 Stage C Apple and Meta attribution envelopes", () => {
    const value = fixture("34-stage-c-apple-meta-attribution").output;
    const reasons = new Set(value.attributions.map((item: Any) => item.reason_code));
    for (const reason of [
      "meta_referrer_decrypted", "meta_referrer_decrypt_failed", "adservices_attributed",
      "adservices_token_expired", "skan_postback_verified", "skan_signature_invalid",
      "postback_not_winner", "crowd_anonymity_suppressed", "conversion_value_null",
    ]) check(reasons.has(reason), `scenario 34 missing ${reason}`);
    check(value.attributions.filter((item: Any) => item.subject_scope === "aggregate").length === 5, "scenario 34 aggregate attribution count");
  }],
  ["35 privacy request authentication scope", () => {
    const value = fixture("35-privacy-request-auth-scope").output;
    const requests = Object.fromEntries(value.privacy_requests.map((item: Any) => [item.privacy_request_id, item]));
    check(requests["privacy-admin-35"].requested_via === "tenant_admin_api", "scenario 35 admin route");
    check(requests["privacy-device-35"].requested_via === "on_device_sdk", "scenario 35 on-device route");
    check(requests["privacy-device-35"].deletion_subject_ref === "installation:device-35", "scenario 35 on-device subject");
    check(value.privacy_tombstones.length === 1 && value.corrections.length === 1, "scenario 35 completed admin deletion");
  }],
  ["36 child-directed audience boundary", () => {
    const value = fixture("36-child-directed-audience");
    check(value.input.server_context.audience === "child_directed", "scenario 36 audience");
    check(value.output.raw_records.length === 1 && value.output.rejections.length === 0, "scenario 36 safe event");
  }],
  ["37 undefined organic ROAS", () => {
    const value = fixture("37-undefined-organic-roas").output;
    check(value.attributions[0].status === "organic", "scenario 37 organic cohort");
    check(value.metric_runs.length === 1 && value.metric_runs[0].value_state === "undefined", "scenario 37 value state");
    check(value.metric_runs[0].undefined_reason === "no_attributed_cost" && value.metric_runs[0].value_unscaled === undefined, "scenario 37 undefined reason");
  }],
  ["38 provider-modeled reconciliation", () => {
    const value = fixture("38-provider-modeled-reconciliation").output;
    check(value.reconciliation.length === 1, "scenario 38 reconciliation count");
    check(value.reconciliation[0].difference_reason_code === "provider_modeled_conversion", "scenario 38 reason");
    check(value.reconciliation[0].difference_reason_version === "0.3.0" && value.reconciliation[0].candidates.length === 0, "scenario 38 classification");
  }],
  ["39 foreign referrer remains unattributed", () => {
    const value = fixture("39-foreign-referrer-unresolved").output;
    check(value.attributions.length === 1, "scenario 39 attribution count");
    check(value.attributions[0].status === "unattributed" && value.attributions[0].reason_code === "foreign_referrer_unresolved", "scenario 39 classification");
  }],
  ["40 custom event and wrapper provenance", () => {
    const value = fixture("40-custom-event-wrapper");
    check(value.output.logical_events[0].event_name === "custom_event", "scenario 40 custom event");
    check(value.output.raw_records[0].producer_variant === "unity" && value.output.raw_records[0].wrapper_version === "0.3.0", "scenario 40 wrapper provenance");
  }],
  ["41 click injection suspicion", () => {
    const value = fixture("41-click-injection-suspected").output;
    check(value.attributions[0].reason_code === "valid_install_referrer", "scenario 41 attribution remains evidence-based");
    check(value.fraud_decisions[0].reason_code === "click_injection_suspected" && value.fraud_decisions[0].action === "flag", "scenario 41 public fraud classification");
  }],
  ["42 daily metric date", () => {
    const value = fixture("42-daily-metric-date").output;
    const runs = Object.fromEntries(value.metric_runs.map((run: Any) => [run.metric_name, run]));
    check(runs.daily_click_count.value_unscaled === "1" && runs.daily_click_count.grouping.dimensions.metric_date === "2026-08-20", "scenario 42 click count");
    check(runs.daily_install_count.value_unscaled === "1" && runs.daily_install_count.grouping.dimensions.attribution_status === "organic", "scenario 42 install count");
    check(value.metric_definitions.some((definition: Any) => definition.definition.calculation === "event_count" && definition.metric_definition_version === "0.3.1"), "scenario 42 definition version");
  }],
  ["43 M4 iOS contract handoffs", () => {
    const value = fixture("43-m4-ios-contract-handoffs");
    const reasons = new Set(value.output.attributions.map((item: Any) => item.reason_code));
    check(reasons.has("adservices_not_attributed") && reasons.has("adservices_lookup_unavailable"), "scenario 43 AdServices states");
    check(value.input.records.filter((record: Any) => record.event_name === "install").every((record: Any) => record.payload.install_origin === "ios_first_launch" && record.payload.referrer_status === "not_applicable"), "scenario 43 iOS install semantics");
    check(value.input.records.some((record: Any) => record.event_name === "adattributionkit_postback" && record.payload.signing_key_environment === "development"), "scenario 43 AAK signing environment");
    check(value.input.records.some((record: Any) => record.event_name === "skan_postback" && record.payload.version === "4.1"), "scenario 43 SKAN minor version");
  }],
  ["44 Apple aggregate metrics", () => {
    const value = fixture("44-apple-aggregate-metrics").output;
    const runs = Object.fromEntries(value.metric_runs.map((run: Any) => [run.metric_run_id, run]));
    check(runs["run-44-skan-count:skan_attributed_installs"].value_unscaled === "2", "scenario 44 SKAN qualified count");
    check(runs["run-44-aak-count:aak_attributed_installs"].value_unscaled === "1", "scenario 44 AAK qualified count");
    check(runs["run-44-skan-fine-21:skan_conversion_value_distribution"].value_unscaled === "1", "scenario 44 fine bucket");
    check(runs["run-44-skan-coarse-low:skan_conversion_value_distribution"].value_unscaled === "1", "scenario 44 coarse bucket");
    check(value.metric_runs.every((run: Any) => run.aggregation_time_zone === "UTC" && run.grouping.dimensions.metric_date === "2026-08-20"), "scenario 44 UTC receipt date");
  }],
  ["45 iOS conversion schema provenance", () => {
    const value = fixture("45-ios-conversion-schema");
    const install = value.input.records.find((record: Any) => record.event_name === "install").payload;
    const update = value.input.records.find((record: Any) => record.event_name === "custom_event").payload;
    check(install.extensions.conversion_schema_version === "openmmp-default-v1" && /^[0-9a-f]{64}$/.test(install.extensions.conversion_schema_sha256), "scenario 45 conversion schema provenance");
    check(update.event_key === "openmmp.conversion_value_updated" && update.attributes.schema_version === install.extensions.conversion_schema_version, "scenario 45 conversion update event");
    check(value.output.attributions[0].reason_code === "platform_referrer_not_available" && value.output.metric_runs.length === 0, "scenario 45 attribution and metric boundary");
  }],
  ["46 platform integrity evidence reservation", () => {
    const value = fixture("46-integrity-verdict-reservation");
    const verdicts = Object.fromEntries(value.output.raw_records.map((record: Any) => [record.record_id, record.integrity_verdict]));
    check(verdicts["play-integrity-verified-46"].provider === "play_integrity" && verdicts["play-integrity-verified-46"].verdict === "verified", "scenario 46 verified Play Integrity evidence");
    check(verdicts["play-integrity-failed-46"].verdict === "failed" && verdicts["play-integrity-failed-46"].evidence_ref.startsWith("protected:"), "scenario 46 failed Play Integrity evidence");
    check(verdicts["app-attest-unavailable-46"].provider === "app_attest" && verdicts["app-attest-unavailable-46"].verdict === "unavailable" && verdicts["app-attest-unavailable-46"].evidence_ref === undefined, "scenario 46 unavailable App Attest evidence");
    check(value.output.attributions.map((item: Any) => item.reason_code).sort().join("|") === "install_referrer_unavailable|no_referrer|platform_referrer_not_available", "scenario 46 integrity does not determine attribution");
  }],
  ["47 payload schema rejection", () => {
    const value = fixture("47-payload-schema-invalid").output;
    check(value.raw_records.length === 0 && value.logical_events.length === 0, "scenario 47 rejected payload entered evidence");
    check(value.deliveries.length === 1 && value.deliveries[0].reason_code === "payload_schema_invalid" && value.deliveries[0].payload_disposition === "discarded", "scenario 47 delivery disposition");
    check(value.rejections.length === 1 && value.rejections[0].retained === "non_identifying_metadata", "scenario 47 rejection retention");
  }],
];
if (!summaryOnly) {
  describe("reviewed scenarios", () => {
    for (const [name, assertion] of scenarios) it(name, assertion);
    it("contains 47 scenario assertions", () => {
      check(scenarios.length === 47, "scenario assertion inventory must contain 47 entries");
    });
  });

  describe("WO-3 Stage A contract extensions", () => {
    it("exercises every registered producer vocabulary form", () => {
      const observed = fixtureStates.flatMap((state) => {
        if (!state.input.ok) return [];
        return fixtureAttempts(state.input.value).map((attempt: Any) => attempt.record.producer);
      });
      for (const registered of producerValues) {
        check(observed.some((producer) => producerMatches(registered, producer)), `producer vocabulary is not exercised: ${registered}`);
      }
    });
    it("exercises every Stage A attribution and rejection reason", () => {
      const attribution = new Set([...results.values()].flatMap(({ output }) => output.attributions.map((item: Any) => item.reason_code)));
      const rejection = new Set([...results.values()].flatMap(({ output }) => output.rejections.map((item: Any) => item.reason_code)));
      for (const reason of ["provider_attributed", "provider_organic", "provider_unattributed", "provider_time_authority_unavailable", "provider_modeled_conversion"]) {
        check(attribution.has(reason), `Stage A attribution reason is not exercised: ${reason}`);
      }
      check(rejection.has("timestamp_stale"), "Stage A rejection reason is not exercised: timestamp_stale");
    });
    it("exercises every status in the imported compatibility row", () => {
      const imported = [...results.values()].flatMap(({ output }) => output.attributions)
        .filter((item: Any) => item.method === "imported" && item.model === "provider_reported");
      check(equal([...new Set(imported.map((item: Any) => item.status))].sort(), ["non_organic", "organic", "unattributed"]), "imported compatibility status coverage");
    });
    it("keeps import context closed on every supported event schema", () => {
      const exercised = new Set<string>();
      for (const name of ["28-imported-provider-attributed", "29-imported-provider-organic", "30-imported-time-authority-unavailable"]) {
        for (const attempt of fixtureAttempts(fixture(name).input)) {
          if (!attempt.record.payload.import_context) continue;
          exercised.add(attempt.record.event_name);
          const validator = validatorFor(`urn:open-mmp:schema:event-${attempt.record.event_name.replaceAll("_", "-")}:v0.3`);
          const event = { ...attempt.record.payload, event_name: attempt.record.event_name };
          check(validator(event), `Stage A import context baseline failed: ${name}/${attempt.record.record_id}`);
          check(!validator({ ...event, import_context: { ...event.import_context, unexpected: "forbidden" } }), `open import_context accepted: ${name}/${attempt.record.record_id}`);
          for (const reserved of ["provider", "provider_click_ref", "import", "imported"]) {
            check(!validator({ ...event, extensions: { [reserved]: "forbidden-bypass" } }), `reserved import field escaped through extensions: ${name}/${attempt.record.record_id}/${reserved}`);
          }
        }
      }
      check(equal([...exercised].sort(), ["ad_revenue", "install", "session_start"]), "import context event coverage");
    });
    it("derives reconciliation without fixture-authored reconciliation inputs", () => {
      const value = fixture("31-imported-reconciliation-derived");
      check(value.input.reconciliation_inputs.length === 0 && value.output.reconciliation.length === 2, "automatic import reconciliation inventory");
      check(value.output.reconciliation.some((item: Any) => item.matching_keys.some((key: Any) => key.type === "provider_install_id")), "provider_install_id derivation");
      check(fixture("28-imported-provider-attributed").output.reconciliation[0].matching_keys.some((key: Any) => key.type === "provider_click_id"), "provider_click_ref to provider_click_id derivation");
      const omitted = structuredClone(value.input);
      delete omitted.reconciliation_inputs;
      const validator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      check(validator(omitted), `reconciliation_inputs must be optional: ${ajv.errorsText(validator.errors)}`);
      check(equal(evaluate(omitted), value.output), "omitting reconciliation_inputs changed automatic output");
      const missingContext = structuredClone(omitted);
      delete missingContext.records.find((record: Any) => record.record_id === "import-unattributed-31").payload.import_context;
      const missingOutput = evaluate(missingContext);
      const missingAttribution = missingOutput.attributions.find((item: Any) => item.attribution_id === "attr:import-unattributed-31");
      const missingReconciliation = missingOutput.reconciliation.find((item: Any) => item.reconciliation_id === "reconciliation:import:import-unattributed-31");
      check(missingAttribution?.method === "imported" && missingAttribution.reason_code === "provider_unattributed", "missing import context fell through to first-party attribution");
      check(missingReconciliation?.difference_reason_code === "join_key_missing", "missing import context did not fail reconciliation closed");
    });
    it("hashes and provider-namespaces protected reconciliation references", () => {
      const baseline = fixture("28-imported-provider-attributed");
      const rawRefs = fixtureAttempts(baseline.input).flatMap((attempt: Any) => {
        const context = attempt.record.payload.import_context ?? {};
        return [context.provider_install_ref, context.provider_click_ref].filter(Boolean);
      });
      const rendered = canonicalize(baseline.output.reconciliation);
      for (const rawRef of rawRefs) check(!rendered.includes(rawRef), `raw provider reference leaked to reconciliation output: ${rawRef}`);
      for (const result of baseline.output.reconciliation) {
        for (const key of result.matching_keys) validateMatchingKey(key, "Stage A imported reconciliation");
      }

      const otherProvider = structuredClone(baseline.input);
      for (const attempt of fixtureAttempts(otherProvider)) {
        if (!attempt.record.producer.startsWith("import:")) continue;
        attempt.record.producer = "import:synthetic-provider-two";
        attempt.record.payload.import_context.provider = "synthetic-provider-two";
      }
      const otherOutput = evaluate(otherProvider);
      check(
        otherOutput.reconciliation[0].matching_keys[0].value !== baseline.output.reconciliation[0].matching_keys[0].value,
        "provider namespace did not change the protected matching-key digest",
      );

      for (const [fixtureName, recordId] of [
        ["28-imported-provider-attributed", "import-install-28"],
        ["29-imported-provider-organic", "import-session-29"],
        ["30-imported-time-authority-unavailable", "import-revenue-30"],
      ]) {
        const mismatchedProvider = structuredClone(fixture(fixtureName).input);
        mismatchedProvider.records.find((record: Any) => record.record_id === recordId).payload.import_context.provider = "synthetic-provider-two";
        check(!capture(() => evaluate(mismatchedProvider)).ok, `TypeScript accepted mismatched import provider: ${fixtureName}/${recordId}`);
        check(!capture(() => pythonOutputs([mismatchedProvider])).ok, `Python accepted mismatched import provider: ${fixtureName}/${recordId}`);
      }
    });
    it("keeps public producer aliases synthetic and treats registry patterns as syntax only", () => {
      for (const state of fixtureStates) {
        if (!state.input.ok) continue;
        for (const attempt of fixtureAttempts(state.input.value)) {
          const producer = attempt.record.producer;
          if (/^(import|adapter|postback):/.test(producer)) {
            check(producer.split(":", 2)[1].startsWith("synthetic-"), `non-synthetic producer alias in public fixture: ${state.name}`);
          }
          const context = attempt.record.payload.import_context;
          if (context) validateSyntheticImportContext(context, `${state.name}/${attempt.record.record_id}`);
        }
      }
      for (const { output } of results.values()) {
        for (const record of output.raw_records) {
          if (/^(import|adapter|postback):/.test(record.producer)) {
            check(record.producer.split(":", 2)[1].startsWith("synthetic-"), "non-synthetic producer alias in public golden output");
          }
        }
      }
      const vendorMutation = structuredClone(fixture("30-imported-time-authority-unavailable").input);
      const mutatedContext = vendorMutation.records.find((record: Any) => record.record_id === "import-install-30").payload.import_context;
      mutatedContext.provider_network = "named-vendor";
      check(!capture(() => validateSyntheticImportContext(mutatedContext, "vendor mutation")).ok, "non-synthetic provider network passed the public fixture guard");
    });
    it("treats the stale threshold as an exclusive lower bound", () => {
      const boundary = structuredClone(fixture("32-timestamp-stale").input);
      boundary.records[0].occurred_at = boundary.server_context.timestamp_stale_policy.before;
      const output = evaluate(boundary);
      check(output.rejections.length === 0 && output.raw_records.length === 1, "timestamp equal to stale threshold must be accepted");

      const disabled = structuredClone(fixture("32-timestamp-stale").input);
      delete disabled.server_context.timestamp_stale_policy;
      const disabledOutput = evaluate(disabled);
      check(disabledOutput.rejections.length === 0 && disabledOutput.raw_records.length === 1, "absent stale policy must be explicitly disabled");

      const fixtureValidator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      const legacy = structuredClone(disabled);
      legacy.server_context.timestamp_stale_before = "2026-08-01T00:00:00.000Z";
      check(!fixtureValidator(legacy), "legacy flat stale threshold was accepted");
      const incomplete = structuredClone(fixture("32-timestamp-stale").input);
      delete incomplete.server_context.timestamp_stale_policy.authority;
      check(!fixtureValidator(incomplete), "incomplete stale policy was accepted");
      const mismatchedDigest = structuredClone(fixture("32-timestamp-stale").input);
      mismatchedDigest.server_context.timestamp_stale_policy.policy_digest = "0".repeat(64);
      check(fixtureValidator(mismatchedDigest), `well-formed stale policy mutation failed schema: ${ajv.errorsText(fixtureValidator.errors)}`);
      check(!capture(() => evaluate(mismatchedDigest)).ok, "stale policy digest was not bound to canonical policy fields");
    });
  });

  describe("WO-3 Stage B dimensions metrics and money", () => {
    it("preserves click and install dimensions and separates advertiser views from mediation impressions", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      const click = value.input.records.find((record: Any) => record.record_id === "click-33").payload;
      const install = value.input.records.find((record: Any) => record.record_id === "install-33").payload;
      check([click.ad_group_id, click.creative_id, click.network, click.country, click.site_id, click.remote_click_ref].every(Boolean), "Stage B click dimensions");
      check(install.country === "JP" && install.app_version && install.os_version && install.sdk_version && install.ad_tracking_limited === false && install.attribution_confirmed_at, "Stage B install dimensions");
      check(value.output.raw_records.some((record: Any) => record.event_name === "ad_view"), "Stage B advertiser-side ad_view");
      check(eventNames.includes("ad_impression") && eventNames.includes("ad_view"), "Stage B advertiser and mediation event names");
    });
    it("supports installation and aggregate ad revenue without inventing an installation anchor", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      const aggregate = value.input.records.find((record: Any) => record.record_id === "aggregate-revenue-33");
      const validator = validatorFor("urn:open-mmp:schema:event-ad-revenue:v0.3");
      check(aggregate.payload.subject_scope === "aggregate" && aggregate.payload.installation_id === undefined, "Stage B aggregate revenue identity");
      check(aggregate.payload.currency === "USD" && aggregate.payload.currency_source === "default", "Stage B default currency provenance");
      check(validator({ ...aggregate.payload, event_name: "ad_revenue" }), `Stage B aggregate revenue schema: ${ajv.errorsText(validator.errors)}`);
      check(!validator({ ...aggregate.payload, installation_id: "installation:forbidden", event_name: "ad_revenue" }), "aggregate revenue accepted installation identity");
      const installation = value.input.records.find((record: Any) => record.record_id === "revenue-33-a").payload;
      const missing = { ...installation, event_name: "ad_revenue" };
      delete missing.installation_id;
      check(!validator(missing), "installation-level revenue accepted without installation_id");
    });
    it("limits synthetic anchor_source to authenticated S2S postback producers", () => {
      const mutated = structuredClone(fixture("33-stage-b-cohort-metrics").input);
      mutated.records.find((record: Any) => record.record_id === "revenue-33-a").payload.anchor_source = "server_user_ref";
      check(!capture(() => evaluate(mutated)).ok, "non-S2S ad revenue accepted anchor_source");
      check(!capture(() => pythonOutputs([mutated])).ok, "Python accepted non-S2S ad revenue anchor_source");
    });
    it("selects the latest cost revision and binds it to the metric snapshot", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      check(value.output.cost_records.length === 2 && value.output.cost_records.every((record: Any) => record.ad_group_id === undefined), "Stage B optional cost ad_group_id");
      const d7 = value.output.metric_runs.find((run: Any) => run.metric_name === "d7_roas");
      check(d7.evidence_refs.some((evidence: Any) => evidence.ref === "cost-33") && !d7.evidence_refs.some((evidence: Any) => evidence.ref === "cost-33-old"), "Stage B current cost evidence");
      const changed = structuredClone(value.input);
      changed.cost_records[1].report_snapshot_digest = "3".repeat(64);
      const changedRun = evaluate(changed).metric_runs.find((run: Any) => run.metric_name === "d7_roas");
      check(changedRun, "Stage B changed cost run missing");
      check(changedRun.value_unscaled === d7.value_unscaled && changedRun.input_snapshot_id !== d7.input_snapshot_id, "Stage B cost snapshot binding");
      const invalid = structuredClone(value.input);
      invalid.cost_records[1].dimension_digest = "4".repeat(64);
      check(!capture(() => evaluate(invalid)).ok, "Stage B invalid cost dimension digest");
    });
    it("drives ratio money and count metrics from closed definitions and grouping", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      const runs = value.output.metric_runs;
      check(runs.every((run: Any) => run.grouping?.dimensions.cohort_date === "2026-08-01" && /^[a-f0-9]{64}$/.test(run.grouping.dimension_digest)), "Stage B grouping contract");
      check(runs.some((run: Any) => run.value_type === "money") && runs.some((run: Any) => run.value_type === "ratio") && runs.some((run: Any) => run.value_type === "count"), "Stage B value type coverage");
      const validator = validatorFor("urn:open-mmp:schema:metric-definition:v0.3");
      const ratio = value.input.metric_definitions.find((definition: Any) => definition.metric_name === "d1_roas");
      check(validator(ratio), `Stage B ratio definition: ${ajv.errorsText(validator.errors)}`);
      check(!validator({ ...ratio, currency: "USD" }), "ratio metric accepted currency");
      const money = structuredClone(value.input.metric_definitions.find((definition: Any) => definition.metric_name === "cohort_ltv_d7_usd"));
      delete money.currency;
      check(!validator(money), "money metric accepted missing currency");
    });
    it("uses the session-start retention default when activity_events is omitted", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      const mutated = structuredClone(value.input);
      const retention = mutated.metric_definitions.find((definition: Any) => definition.metric_name === "retention_d1");
      delete retention.activity_events;
      const validator = validatorFor("urn:open-mmp:schema:metric-definition:v0.3");
      check(validator(retention), `Stage B retention default schema: ${ajv.errorsText(validator.errors)}`);
      const typescript = evaluate(mutated);
      const [python] = pythonOutputs([mutated]);
      check(equal(typescript, python), "Stage B retention default cross-language mismatch");
      check(typescript.metric_runs.find((run: Any) => run.metric_name === "retention_d1")?.value_unscaled === "1000000", "Stage B retention default result");
    });
    it("gives a normalized direct country precedence over imported country evidence", () => {
      const mutated = structuredClone(fixture("33-stage-b-cohort-metrics").input);
      mutated.records.find((record: Any) => record.record_id === "install-33").payload.country = "US";
      mutated.metric_evaluations[0].metric_names = ["d1_roas"];
      const typescript = evaluate(mutated);
      const [python] = pythonOutputs([mutated]);
      check(equal(typescript, python), "Stage B direct/imported country precedence mismatch");
      check(typescript.metric_runs.find((run: Any) => run.metric_run_id === "run-33:d1_roas")?.value_unscaled === "0", "Stage B direct country did not exclude conflicting imported evidence");
    });
    it("rounds each revenue event half-even before exact summation", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      const source = value.input.records.filter((record: Any) => record.record_id.startsWith("revenue-33-"));
      check(source.length === 3 && source.every((record: Any) => record.payload.amount_unscaled === "100000001" && record.payload.amount_scale === 6), "Stage B half-even source vector");
      const metrics = Object.fromEntries(value.output.metric_runs.map((run: Any) => [run.metric_name, run.value_unscaled]));
      check(metrics.d1_roas === "500000" && metrics.d3_roas === "1000000" && metrics.d7_roas === "1500000", "Stage B per-event rounded totals");
    });
    it("requires import adapters to provide canonical millisecond timestamps", () => {
      const value = fixture("33-stage-b-cohort-metrics");
      const aggregate = value.input.records.find((record: Any) => record.record_id === "aggregate-revenue-33");
      check(aggregate.occurred_at.endsWith(".123Z") && aggregate.payload.import_context.provider_confirmed_at.endsWith(".123Z"), "Stage B normalized timestamp evidence");
      const invalid = structuredClone(value.input);
      invalid.records.find((record: Any) => record.record_id === "aggregate-revenue-33").occurred_at = "2026-08-02T12:00:00.123987Z";
      const validator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      check(!validator(invalid), "Stage B accepted timestamp precision above milliseconds");
    });
  });

  describe("WO-3 Stage C Apple and Meta attribution", () => {
    it("exercises every new compatibility row", () => {
      const output = fixture("34-stage-c-apple-meta-attribution").output;
      const observed = new Set(output.attributions.map((item: Any) => `${item.subject_scope}|${item.method}|${item.model}`));
      for (const row of [
        "aggregate|skadnetwork|aggregate",
        "aggregate|adattributionkit|aggregate",
        "installation_level|meta_install_referrer|last_click",
        "installation_level|meta_install_referrer|view_through",
        "installation_level|apple_adservices|last_click",
      ]) {
        check(compatibility.some((item: Any) => `${item.subject_scope}|${item.method}|${item.model}` === row), `Stage C compatibility row missing: ${row}`);
        check(observed.has(row), `Stage C compatibility row not exercised: ${row}`);
      }
    });
    it("exercises every Stage C reason and both postback event names", () => {
      const output = fixture("34-stage-c-apple-meta-attribution").output;
      const reasons = new Set(output.attributions.map((item: Any) => item.reason_code));
      for (const reason of [
        "meta_referrer_decrypted", "meta_referrer_decrypt_failed", "adservices_attributed",
        "adservices_token_expired", "skan_postback_verified", "skan_signature_invalid",
        "postback_not_winner", "crowd_anonymity_suppressed", "conversion_value_null",
      ]) check(reasons.has(reason), `Stage C reason not exercised: ${reason}`);
      check(output.raw_records.some((item: Any) => item.event_name === "skan_postback"), "Stage C SKAN event not exercised");
      check(output.raw_records.some((item: Any) => item.event_name === "adattributionkit_postback"), "Stage C AAK event not exercised");
    });
    it("accepts verified Meta identifiers while excluding free-text names", () => {
      const installValidator = validatorFor("urn:open-mmp:schema:event-install:v0.3");
      const input = fixture("34-stage-c-apple-meta-attribution").input;
      const decrypted = structuredClone(input.records.find((item: Any) => item.record_id === "meta-click-install-34").payload);
      check(installValidator({ event_name: "install", ...decrypted }), `Stage C rejected verified Meta fields: ${ajv.errorsText(installValidator.errors)}`);
      decrypted.meta_referrer_context.campaign_name = "forbidden-free-text";
      check(!installValidator({ event_name: "install", ...decrypted }), "Stage C accepted a Meta campaign name");
      const absent = structuredClone(input.records.find((item: Any) => item.record_id === "meta-absent-install-34").payload);
      absent.meta_referrer_context = { attribution_model: "last_click" };
      check(!installValidator({ event_name: "install", ...absent }), "Stage C accepted Meta context when no campaign data exists");
    });
    it("validates normalized Apple envelopes and aggregate subject namespaces", () => {
      const value = fixture("34-stage-c-apple-meta-attribution");
      const skanValidator = validatorFor("urn:open-mmp:schema:event-skan-postback:v0.3");
      const aakValidator = validatorFor("urn:open-mmp:schema:event-adattributionkit-postback:v0.3");
      const installValidator = validatorFor("urn:open-mmp:schema:event-install:v0.3");
      const skan = value.input.records.find((item: Any) => item.record_id === "skan-verified-34").payload;
      const aak = value.input.records.find((item: Any) => item.record_id === "aak-not-winner-34").payload;
      const adservices = value.input.records.find((item: Any) => item.record_id === "adservices-install-34").payload;
      check(skanValidator({ event_name: "skan_postback", ...skan }), `Stage C SKAN schema: ${ajv.errorsText(skanValidator.errors)}`);
      check(aakValidator({ event_name: "adattributionkit_postback", ...aak }), `Stage C AAK schema: ${ajv.errorsText(aakValidator.errors)}`);

      const validV3 = structuredClone(skan);
      validV3.version = "3.0";
      validV3.campaign_id = 42;
      delete validV3.source_identifier;
      delete validV3.postback_sequence_index;
      check(skanValidator({ event_name: "skan_postback", ...validV3 }), `Stage C rejected valid SKAN v3 envelope: ${ajv.errorsText(skanValidator.errors)}`);
      const unsupportedV2 = structuredClone(validV3);
      unsupportedV2.version = "2.2";
      check(!skanValidator({ event_name: "skan_postback", ...unsupportedV2 }), "Stage C accepted out-of-scope SKAN v2");

      const v4Campaign = structuredClone(skan);
      v4Campaign.campaign_id = 42;
      check(!skanValidator({ event_name: "skan_postback", ...v4Campaign }), "Stage C accepted campaign_id in SKAN v4");
      const bothConversions = structuredClone(skan);
      bothConversions.coarse_conversion_value = "high";
      check(!skanValidator({ event_name: "skan_postback", ...bothConversions }), "Stage C accepted fine and coarse SKAN values together");
      const fineLaterWindow = structuredClone(skan);
      fineLaterWindow.postback_sequence_index = 1;
      check(!skanValidator({ event_name: "skan_postback", ...fineLaterWindow }), "Stage C accepted a fine value after the first SKAN window");

      const reengagement = structuredClone(aak);
      reengagement.conversion_type = "re-engagement";
      check(!aakValidator({ event_name: "adattributionkit_postback", ...reengagement }), "Stage C accepted out-of-scope re-engagement");
      const unknownConversion = structuredClone(adservices);
      unknownConversion.adservices_context.conversion_type = "Unknown";
      check(!installValidator({ event_name: "install", ...unknownConversion }), "Stage C accepted an unknown AdServices conversion type");
      check(value.output.attributions.filter((item: Any) => item.subject_scope === "aggregate").every((item: Any) => item.subject_ref.startsWith(`aggregate:${item.method}:`)), "Stage C aggregate subject namespace");
    });
    it("validates the additive M4 iOS handoff vocabulary", () => {
      const value = fixture("43-m4-ios-contract-handoffs");
      const installValidator = validatorFor("urn:open-mmp:schema:event-install:v0.3");
      const skanValidator = validatorFor("urn:open-mmp:schema:event-skan-postback:v0.3");
      const aakValidator = validatorFor("urn:open-mmp:schema:event-adattributionkit-postback:v0.3");
      const notAttributed = structuredClone(value.input.records.find((item: Any) => item.record_id === "ios-not-attributed-43").payload);
      check(installValidator({ event_name: "install", ...notAttributed }), `M4 iOS install baseline: ${ajv.errorsText(installValidator.errors)}`);
      notAttributed.adservices_context.attribution = true;
      check(!installValidator({ event_name: "install", ...notAttributed }), "M4 accepted attribution=true for not_attributed");

      const skan = structuredClone(value.input.records.find((item: Any) => item.record_id === "skan-minor-43").payload);
      check(skanValidator({ event_name: "skan_postback", ...skan }), `M4 SKAN 4.x baseline: ${ajv.errorsText(skanValidator.errors)}`);
      skan.version = "5.0";
      check(!skanValidator({ event_name: "skan_postback", ...skan }), "M4 accepted unsupported SKAN major version");

      const aak = structuredClone(value.input.records.find((item: Any) => item.record_id === "aak-development-key-43").payload);
      check(aakValidator({ event_name: "adattributionkit_postback", ...aak }), `M4 AAK key environment baseline: ${ajv.errorsText(aakValidator.errors)}`);
      aak.signing_key_environment = "synthetic";
      check(!aakValidator({ event_name: "adattributionkit_postback", ...aak }), "M4 accepted an unknown AAK signing key environment");
    });
  });

  describe("WO-5.5 Stage 1 attribution vocabulary", () => {
    it("distinguishes Play-organic third-party evidence, foreign referrers, and unknown first-party clicks", () => {
      const organic = fixture("02-organic-no-referrer").output.attributions[0];
      const foreign = fixture("39-foreign-referrer-unresolved").output.attributions[0];
      const unknown = fixture("03-unknown-click").output.attributions[0];
      check(organic.status === "organic" && organic.reason_code === "no_first_party_referrer", "Play-organic third-party classification");
      check(foreign.status === "unattributed" && foreign.reason_code === "foreign_referrer_unresolved", "foreign referrer classification");
      check(unknown.status === "unattributed" && unknown.reason_code === "unknown_click_id", "unknown first-party click classification");
    });
    it("exercises every Meta coverage state and Install Referrer client response", () => {
      const records = fixture("34-stage-c-apple-meta-attribution").input.records.filter((record: Any) => record.event_name === "install");
      const metaStates = [...new Set(records.map((record: Any) => record.payload.meta_referrer_status).filter(Boolean))].sort();
      const clientResponses = [...new Set(records.map((record: Any) => record.payload.referrer_client_response).filter(Boolean))].sort();
      check(equal(metaStates, ["app_version_unsupported", "auth_failed", "decrypt_failed", "decrypted", "no_campaign_data", "provider_unavailable"]), "Meta status coverage");
      check(equal(clientResponses, ["developer_error", "feature_not_supported", "ok", "permission_error", "service_disconnected", "service_unavailable"]), "Install Referrer response coverage");
    });
    it("gives decrypted Meta evidence precedence over a resolvable first-party click", () => {
      const value = fixture("34-stage-c-apple-meta-attribution");
      check(value.input.records.some((record: Any) => record.record_id === "meta-first-party-click-34"), "first-party comparison click missing");
      const attribution = value.output.attributions.find((item: Any) => item.attribution_id === "attr:meta-click-install-34");
      check(attribution?.method === "meta_install_referrer" && attribution.reason_code === "meta_referrer_decrypted", "Meta precedence");
    });
    it("records install origin and SAN strategy without overloading producer identity", () => {
      const origin = fixture("34-stage-c-apple-meta-attribution").input.records.find((record: Any) => record.record_id === "meta-provider-unavailable-install-34").payload;
      const imported = fixture("28-imported-provider-attributed").input.records.find((record: Any) => record.record_id === "import-install-28");
      check(origin.install_origin === "identifier_reset", "identifier reset origin coverage");
      check(imported.producer === "import:synthetic-provider" && imported.payload.import_context.provider_attribution_strategy === "self_attributed_network", "SAN strategy coverage");
    });
    it("resolves imported click evidence from a first-party redirector record", () => {
      const attribution = fixture("28-imported-provider-attributed").output.attributions[0];
      check(attribution.evidence_refs.map((entry: Any) => entry.ref).join(",") === "import-click-28,import-install-28", "imported click evidence");
    });
    it("derives candidate-missing and external-row-unmatched as distinct reasons", () => {
      const reasons = new Set(fixture("03-unknown-click").output.reconciliation.map((item: Any) => item.difference_reason_code));
      check(reasons.has("candidate_missing") && reasons.has("external_row_unmatched"), "H-11 reason distinction");
    });
    it("keeps organic and non-organic ROAS in separate attribution-status rows", () => {
      const runs = fixture("33-stage-b-cohort-metrics").output.metric_runs.filter((run: Any) => run.metric_name === "d1_roas");
      const organic = runs.find((run: Any) => run.grouping.dimensions.attribution_status === "organic");
      const paid = runs.find((run: Any) => run.grouping.dimensions.attribution_status === "non_organic");
      check(organic?.value_state === "undefined" && organic.undefined_reason === "no_attributed_cost", "organic ROAS row");
      check(paid?.value_unscaled === "500000" && (paid.value_state ?? "present") === "present", "non-organic ROAS row");
    });
  });

  describe("WO-5.5 Stage 2 SDK-facing contract extensions", () => {
    it("validates verified Meta outer evidence and typed decrypted identifiers", () => {
      const payload = fixture("34-stage-c-apple-meta-attribution").input.records.find((record: Any) => record.record_id === "meta-click-install-34").payload;
      check(payload.is_ct === 1 && Number.isInteger(payload.actual_timestamp), "Meta outer evidence");
      check(payload.meta_referrer_context.campaign_id && payload.meta_referrer_context.adgroup_id && payload.meta_referrer_context.ad_id, "Meta identifier coverage");
      check(!("campaign_name" in payload.meta_referrer_context) && !("adgroup_name" in payload.meta_referrer_context), "Meta free-text name exclusion");
    });
    it("keeps custom events closed, bounded, and scalar-only", () => {
      const validator = validatorFor("urn:open-mmp:schema:event-custom-event:v0.3");
      const payload = fixture("40-custom-event-wrapper").input.records[0].payload;
      check(validator({ event_name: "custom_event", ...payload }), `custom event baseline: ${ajv.errorsText(validator.errors)}`);
      check(!validator({ event_name: "custom_event", ...payload, event_key: "Invalid-Key" }), "custom event accepted an invalid event key");
      check(!validator({ event_name: "custom_event", ...payload, attributes: { nested: { forbidden: true } } }), "custom event accepted nested attributes");
      check(!validator({ event_name: "custom_event", ...payload, attributes: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key_${index}`, index])) }), "custom event accepted more than 20 attributes");
    });
    it("derives CTIT from server authority and keeps the ten-second boundary clear", () => {
      const baseline = fixture("41-click-injection-suspected");
      check(baseline.output.fraud_decisions.some((item: Any) => item.reason_code === "click_injection_suspected"), "9.999-second CTIT classification");
      const boundary = structuredClone(baseline.input);
      const install = boundary.records.find((record: Any) => record.record_id === "install-41");
      install.payload.install_begin_at_server = "2026-08-19T02:00:10.000Z";
      const typescript = evaluate(boundary);
      const [python] = pythonOutputs([boundary]);
      check(equal(typescript, python), "CTIT boundary cross-language mismatch");
      check(!typescript.fraud_decisions.some((item: Any) => item.reason_code === "click_injection_suspected"), "ten-second CTIT was classified as below threshold");
    });
    it("exercises MAX-compatible revenue precision without changing amount semantics", () => {
      const validator = validatorFor("urn:open-mmp:schema:event-ad-revenue:v0.3");
      const payload = fixture("27-ad-impression-revenue-link").input.records.find((record: Any) => record.record_id === "revenue-27").payload;
      check(payload.revenue_precision === "exact" && validator({ event_name: "ad_revenue", ...payload }), "revenue precision fixture");
      for (const precision of ["exact", "estimated", "publisher_defined", "undefined"]) {
        check(validator({ event_name: "ad_revenue", ...payload, revenue_precision: precision }), `revenue precision enum: ${precision}`);
      }
      check(!validator({ event_name: "ad_revenue", ...payload, revenue_precision: "undisclosed" }), "unsupported revenue precision was accepted");
    });
    it("keeps Kotlin core and wrapper versions in separate raw-record fields", () => {
      const input = fixture("40-custom-event-wrapper").input.records[0];
      const raw = fixture("40-custom-event-wrapper").output.raw_records[0];
      check(input.producer_version === raw.producer_version && raw.producer_variant === "unity" && raw.wrapper_version === "0.3.0", "wrapper provenance separation");
    });
  });

  describe("WO-3 Stage D processing purposes", () => {
    it("closes every fixture purpose reference against the registry", () => {
      const exercised = new Set<string>();
      for (const state of fixtureStates) {
        if (!state.input.ok) continue;
        for (const attempt of fixtureAttempts(state.input.value)) {
          const purpose = attempt.record.processing_purpose_id;
          if (purpose !== undefined) {
            check(processingPurposeSet.has(purpose), `unknown record purpose in ${state.name}: ${purpose}`);
            exercised.add(purpose);
          }
          for (const entry of attempt.server.processing_purposes ?? []) {
            check(processingPurposeSet.has(entry.processing_purpose_id), `unknown server purpose in ${state.name}: ${entry.processing_purpose_id}`);
          }
          for (const entry of attempt.server.withdrawals ?? []) {
            check(processingPurposeSet.has(entry.processing_purpose_id), `unknown withdrawal purpose in ${state.name}: ${entry.processing_purpose_id}`);
          }
          for (const entry of attempt.server.alternative_legal_bases ?? []) {
            check(processingPurposeSet.has(entry.processing_purpose_id), `unknown alternative-basis purpose in ${state.name}: ${entry.processing_purpose_id}`);
          }
        }
      }
      check(equal([...exercised].sort(), [...processingPurposeIds].sort()), "not every processing purpose is exercised");
    });
    it("rejects unknown purpose IDs at fixture and output boundaries", () => {
      const invalidInput = structuredClone(fixture("34-stage-c-apple-meta-attribution").input);
      invalidInput.records[0].processing_purpose_id = "unregistered_purpose";
      const inputValidator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      check(!inputValidator(invalidInput), "fixture schema accepted unknown record purpose");

      const invalidDelivery = structuredClone(fixture("34-stage-c-apple-meta-attribution").output.deliveries[0]);
      invalidDelivery.processing_purpose_id = "unregistered_purpose";
      check(!validatorFor(outputSchemaIds.deliveries)(invalidDelivery), "delivery schema accepted unknown purpose");
    });
    it("requires privacy authentication provenance and defines app audience", () => {
      const privacy = schemaValue("urn:open-mmp:schema:privacy-request:v0.3");
      const fixtureSchema = schemaValue("urn:open-mmp:schema:fixture-input:v0.3");
      check(equal(privacy.properties.requested_via.enum, ["on_device_sdk", "tenant_admin_api"]), "privacy request route enum mismatch");
      check(privacy.required.includes("requested_via") && privacy.required.includes("requester_auth_ref"), "privacy authentication provenance is optional");
      const audience = fixtureSchema.$defs.serverContext.properties.audience;
      check(equal(audience.enum, ["general", "mixed", "child_directed"]), "app audience enum mismatch");
      check(audience.default === "general", "app audience default mismatch");
    });
  });
}

const contractText = capture(() => readFileSync(join(root, "spec", "event-metric-contract-v0.3.md"), "utf8"));
const fraudSchemaText = capture(() => readFileSync(join(root, "schemas", "fraud-decision.schema.json"), "utf8"));
const acceptance: Array<[string, () => void]> = [
  ["AC01 Draft 2020-12 schemas have stable IDs and versions", () => check(schemaPaths.length === 27 && schemaIds.every(Boolean), "AC01")],
  ["AC02 canonical event names agree across registry and schemas", () => {
    const rawSchema = schemaValues.find(({ value }) => value.$id === outputSchemaIds.raw_records)?.value;
    check(rawSchema, "AC02 raw schema missing");
    const eventEnum = rawSchema.properties.event_name.enum;
    check(equal(eventEnum, eventNames), "AC02 raw registry mismatch");
    for (const name of eventNames) validatorFor(`urn:open-mmp:schema:event-${name.replaceAll("_", "-")}:v0.3`);
  }],
  ["AC03 raw delivery logical correction and derived artifacts are separate", () => {
    check(Object.keys(outputSchemaIds).length === 13 && Object.values(expectedFiles).every((name) => name.startsWith("expected_")), "AC03");
  }],
  ["AC04 tenant-scoped idempotency duplicate and conflict fixtures pass", () => {
    check(fixture("05-duplicate-delivery").output.deliveries.some((item: Any) => item.duplicate_resolution === "duplicate_delivery"), "AC04 duplicate");
    check(fixture("06-event-id-conflict").output.rejections.some((item: Any) => item.reason_code === "event_id_conflict"), "AC04 conflict");
    check(fixture("07-same-id-across-tenants").output.raw_records.filter((item: Any) => item.event_id === "shared-event-id").length === 2, "AC04 tenant");
  }],
  ["AC05 server-auth scope rejects client mismatch", () => check(fixture("07-same-id-across-tenants").output.rejections.some((item: Any) => item.reason_code === "client_scope_mismatch"), "AC05")],
  ["AC06 orthogonal state axes and transitions are machine readable", () => check(Object.keys(stateAxes).length === 7 && stateAxes.privacy_request.states.includes("completed") && stateAxes.record_lifecycle.states.includes("retracted") && stateAxes.payload_availability.states.includes("purged"), "AC06")],
  ["AC07 attribution includes policy scope method model reason and cutoff", () => {
    for (const { output } of results.values()) for (const item of output.attributions) {
      for (const field of ["subject_scope", "method", "model", "reason_code", "reason_code_version", "input_cutoff_at", "rule_bundle_version", "rule_bundle_hash"]) check(item[field] !== undefined, `AC07 ${field}`);
    }
  }],
  ["AC08 organic and unattributed are distinct", () => check(fixture("02-organic-no-referrer").output.attributions[0].status === "organic" && fixture("03-unknown-click").output.attributions[0].status === "unattributed", "AC08")],
  ["AC09 aggregate result cannot carry installation identity", () => {
    const validator = validatorFor(outputSchemaIds.attributions);
    const source = fixture("02-organic-no-referrer").output.attributions[0];
    const aggregate = { ...source, subject_scope: "aggregate", subject_ref: "aggregate:cohort-test" };
    check(validator(aggregate), `AC09 aggregate namespace baseline: ${ajv.errorsText(validator.errors)}`);
    check(!validator({ ...aggregate, subject_ref: "installation:forbidden" }), "AC09 aggregate namespace must reject installation identity");
    check(!validator({ ...source, subject_ref: "aggregate:forbidden" }), "AC09 installation namespace must reject aggregate identity");
  }],
  ["AC10 subject scope uses installation_level and never user_level", () => {
    check(compatibility.every((row: Any) => row.subject_scope !== "user_level"), "AC10 registry");
    for (const { output } of results.values()) check(output.attributions.every((item: Any) => item.subject_scope !== "user_level"), "AC10 output");
  }],
  ["AC11 three D0 definitions recalculate independently", () => {
    const metrics = fixture("09-utc-jst-calendar").output.metric_runs;
    check(new Set(metrics.map((item: Any) => item.metric_name)).size === 3 && new Set(metrics.map((item: Any) => item.value_unscaled)).size > 1, "AC11");
  }],
  ["AC12 currency FX rounding and watermark are reproducible", () => {
    const runs = fixture("08-late-ad-revenue").output.metric_runs;
    check(runs.every((item: Any) => item.fx_rate_unscaled && Number.isInteger(item.fx_rate_scale) && item.fx_rate_source && item.fx_rate_as_of && item.fx_rate_snapshot_id && item.fx_policy_version === "fx-v0.1" && item.rounding_mode === "half_even" && item.input_received_at_watermark), "AC12");
    const tie = structuredClone(fixture("08-late-ad-revenue").input);
    tie.fx_policy = {
      policy_version: "fx-half-even-test", target_currency: "USD", target_scale: 0,
      rounding_mode: "half_even",
      rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, source: "synthetic-tie", as_of: "2026-08-12T00:00:00.000Z" }],
    };
    tie.records[1].payload.currency = "USD";
    tie.records[1].payload.amount_scale = 1;
    tie.records[1].payload.amount_unscaled = "5";
    const evenDown = evaluate(tie).metric_runs.find((item: Any) => item.metric_run_id.startsWith("run-08-recalculated") && item.metric_name.includes("_24h_"));
    check(evenDown, "AC12 missing half-even down metric");
    check(evenDown.value_unscaled === "0", "AC12 half-even tie to even zero");
    tie.records[1].payload.amount_unscaled = "15";
    const evenUp = evaluate(tie).metric_runs.find((item: Any) => item.metric_run_id.startsWith("run-08-recalculated") && item.metric_name.includes("_24h_"));
    check(evenUp, "AC12 missing half-even up metric");
    check(evenUp.value_unscaled === "2", "AC12 half-even tie to even two");
  }],
  ["AC13 high-precision source amount survives ingestion", () => {
    const { input, output } = fixture("08-late-ad-revenue");
    const source = input.records.find((item: Any) => item.record_id === "revenue-late");
    const raw = output.raw_records.find((item: Any) => item.record_id === "revenue-late");
    check(source.payload.amount_unscaled === "123456789012345678" && raw.payload_sha256 === sha256(source.payload), "AC13");
  }],
  ["AC14 immutable snapshot fixes ordered received evidence", () => {
    const { input, output } = fixture("08-late-ad-revenue");
    const initial = output.metric_runs.find((item: Any) => item.metric_run_id.startsWith("run-08-initial"));
    const recalculated = output.metric_runs.find((item: Any) => item.metric_run_id.startsWith("run-08-recalculated"));
    check(initial && recalculated, "AC14 missing snapshot runs");
    check(initial.input_snapshot_id !== recalculated.input_snapshot_id, "AC14 cutoff snapshots");
    const reordered = structuredClone(input);
    reordered.records.reverse();
    check(equal(evaluate(reordered).metric_runs, output.metric_runs), "AC14 input ordering");
    const changed = structuredClone(input);
    changed.records[1].received_at = "2026-08-13T00:00:00.001Z";
    const changedRun = evaluate(changed).metric_runs.find((item: Any) => item.metric_run_id.startsWith("run-08-recalculated"));
    check(changedRun && changedRun.input_snapshot_id !== recalculated.input_snapshot_id, "AC14 received_at binding");
  }],
  ["AC15 correction retraction redaction and post-deletion recalculation are causal", () => {
    const corrections = fixture("16-correction-refund").output.corrections;
    check(corrections.some((item: Any) => item.correction_reason === "refund" && item.corrects_record_id === "purchase-16"), "AC15 correction");
    check(corrections.some((item: Any) => item.correction_type === "retraction"), "AC15 retraction");
    check(fixture("17-redaction-recalculation").output.metric_runs.some((item: Any) => item.supersedes_metric_run_id), "AC15 redaction");
  }],
  ["AC16 clock referrer prefetch and withdrawal fixtures pass", () => check(scenarios.length === 47 && fixture("11-clock-skew").output.deliveries.some((item: Any) => item.clock_skew_suspected) && fixture("13-referrer-unsupported").output.attributions.length === 2 && fixture("19-bot-prefetch").output.fraud_decisions.length === 1 && fixture("41-click-injection-suspected").output.fraud_decisions.length === 1 && fixture("20-timestamp-invalid").output.rejections.some((item: Any) => item.reason_code === "timestamp_invalid"), "AC16")],
  ["AC17 server-recognized withdrawal rejects and redacts payload", () => {
    for (const name of ["14-withdrawal-after-occurrence", "15-event-after-withdrawal"]) {
      const value = fixture(name).output;
      check(value.rejections.some((item: Any) => item.reason_code === "consent_withdrawn" && item.withdrawal_recognized_at && item.payload_disposition === "discarded"), `AC17 ${name}`);
    }
  }],
  ["AC18 lawful redaction marks evidence and supersedes runs", () => {
    const value = fixture("17-redaction-recalculation").output;
    check(value.privacy_tombstones.length === 2 && value.metric_runs.filter((item: Any) => item.metric_run_id.startsWith("run-17-after")).every((item: Any) => item.reproducibility_status === "redaction_affected" && item.supersedes_metric_run_id), "AC18");
  }],
  ["AC19 reconciliation derives deterministic neutral reasons", () => {
    const base = fixture("01-valid-install-referrer");
    check(base.output.reconciliation[0].difference_reason_code === "matched", "AC19 matched");
    const mutated = structuredClone(base.input);
    mutated.reconciliation_inputs[0].matching_keys[0].value = "not-present";
    check(evaluate(mutated).reconciliation[0].difference_reason_code === "candidate_missing", "AC19 derived mutation");
    const normalized = structuredClone(base.input);
    const composite = {
      type: "tenant_app_composite", value: "TENANT-A|APP-A", scope: "tenant_app",
      normalization: "lowercase_ascii", cardinality: "one_to_many", protected: true,
    };
    normalized.reconciliation_inputs[0].matching_keys = [composite];
    normalized.reconciliation_inputs[0].candidates[0].matching_keys = [{ ...composite, value: "tenant-a|app-a" }];
    check(evaluate(normalized).reconciliation[0].difference_reason_code === "matched", "AC19 normalization");
    normalized.reconciliation_inputs[0].candidates[0].app_id = "app-b";
    check(evaluate(normalized).reconciliation[0].difference_reason_code === "external_row_unmatched", "AC19 tenant-app scope");
    const ambiguous = structuredClone(base.input);
    ambiguous.reconciliation_inputs[0].candidates.push({
      ...ambiguous.reconciliation_inputs[0].candidates[0],
      candidate_id: "install-1-duplicate",
    });
    check(evaluate(ambiguous).reconciliation[0].difference_reason_code === "join_key_ambiguous", "AC19 cardinality");
  }],
  ["AC20 public fraud envelope excludes live defenses", () => {
    const schemaText = capturedValue(fraudSchemaText, "AC20 fraud schema read failure");
    const specText = capturedValue(contractText, "AC20 contract read failure");
    for (const forbidden of ["threshold", "model_weight", "watchlist", "ip_address", "user_agent", "response_timing"]) check(!schemaText.includes(forbidden), `AC20 ${forbidden}`);
    check(specText.includes("remain private"), "AC20 private boundary");
  }],
  ["AC21 one command validates every schema registry fixture and golden", () => check(schemaPaths.length === 27 && Object.keys(registries).length === 8 && fixtureDirs.length === 47 && outputArtifactCount === 47 * 13, "AC21")],
  ["AC22 repeated and independent evaluators produce identical JCS", () => {
    for (const { output, python } of results.values()) check(equal(output, python), "AC22 evaluator mismatch");
    const vector = { numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0], string: "€$\u000f\nA'B\"\\\"/" };
    const python = execFileSync("python", [join(root, "tools", "python_evaluator.py"), "--conformance"], { encoding: "utf8" }).trim();
    check(canonicalize(vector) === python, "AC22 RFC 8785 conformance vector");
  }],
  ["AC23 paid evidence dominates reinstall lifecycle classification", () => {
    const base = fixture("10-reinstall-redownload");
    const changed = structuredClone(base.input);
    changed.records.find((item: Any) => item.record_id === "install-10b").payload.install_type = "redownload";
    const attr = evaluate(changed).attributions.find((item: Any) => item.attribution_id === "attr:install-10b");
    check(attr, "AC23 missing paid redownload attribution");
    check(attr.status === "non_organic" && attr.reason_code === "valid_install_referrer", "AC23 paid redownload");
  }],
  ["AC24 record ID collisions reject every colliding delivery", () => {
    const collision = structuredClone(fixture("01-valid-install-referrer").input);
    const source = collision.records[0];
    collision.records.push({ ...source, delivery_id: "delivery:record-id-collision", event_id: "event:record-id-collision" });
    const output = evaluate(collision);
    const colliding = output.deliveries.filter((item: Any) => item.record_id === source.record_id);
    check(colliding.length === 2 && colliding.every((item: Any) => item.ingestion_status === "rejected" && item.duplicate_resolution === "record_id_collision"), "AC24 delivery collision");
    check(output.rejections.filter((item: Any) => item.record_id === source.record_id && item.reason_code === "record_id_collision").length === 2, "AC24 rejection collision");
    check(!output.raw_records.some((item: Any) => item.record_id === source.record_id), "AC24 collision evidence rejected");
    const scoped = structuredClone(fixture("01-valid-install-referrer").input);
    const scopedSource = scoped.records.find((item: Any) => item.event_name === "click");
    const record = {
      ...scopedSource,
      record_id: "cross-scope-same-context",
      delivery_id: "delivery:cross-scope-same-context",
      event_id: "event:cross-scope-same-context",
    };
    scoped.batches = [
      { batch_id: "batch-cross-scope", server_context: { ...scoped.server_context }, records: [{ ...record }] },
      {
        batch_id: "batch-cross-scope",
        server_context: { ...scoped.server_context, tenant_id: "tenant-b", app_id: "app-b" },
        records: [{ ...record, tenant_id: "tenant-b", app_id: "app-b" }],
      },
    ];
    delete scoped.server_context;
    delete scoped.records;
    const scopedOutput = evaluate(scoped);
    const scopedReordered = reorderedInput(scoped);
    const scopedReorderedOutput = evaluate(scopedReordered);
    const [scopedPython, scopedReorderedPython] = pythonOutputs([scoped, scopedReordered]);
    check(equal(scopedOutput, scopedReorderedOutput), "AC24 cross-scope same-context reorder");
    check(equal(scopedOutput, scopedPython) && equal(scopedReorderedOutput, scopedReorderedPython), "AC24 cross-scope Python agreement");
    check(scopedOutput.deliveries.length === 2 && scopedOutput.deliveries.every((item: Any) => item.reason_code === "record_id_collision"), "AC24 cross-scope collision deliveries");
    check(scopedOutput.raw_records.length === 0 && scopedOutput.logical_events.length === 0 && scopedOutput.attributions.length === 0, "AC24 cross-scope collision no derived leakage");
  }],
  ["AC25 click ambiguity never selects the first candidate", () => {
    const ambiguous = structuredClone(fixture("01-valid-install-referrer").input);
    const source = ambiguous.records.find((item: Any) => item.event_name === "click");
    ambiguous.records.push({ ...source, record_id: "click-ambiguous", delivery_id: "delivery:click-ambiguous", event_id: "event:click-ambiguous" });
    const output = evaluate(ambiguous);
    check(output.attributions[0].status === "unattributed" && output.attributions[0].reason_code === "ambiguous_click_id", "AC25 ambiguous click");
    check(equal(output, evaluate(reorderedInput(ambiguous))), "AC25 ambiguous click reorder");
  }],
  ["AC26 installation anchors are explicit and unambiguous", () => {
    const invalid = structuredClone(fixture("10-reinstall-redownload").input);
    const install = invalid.records.find((item: Any) => item.record_id === "install-10c");
    install.payload.prior_installation_id = install.payload.installation_id;
    let rejected = false;
    try { evaluate(invalid); } catch { rejected = true; }
    check(rejected, "AC26 self-referential reinstall anchor");
  }],
];
if (!summaryOnly) {
  describe("acceptance criteria", () => {
    for (const [name, assertion] of acceptance) it(name, assertion);
    it("contains 26 acceptance criteria", () => {
      check(acceptance.length === 26, "acceptance inventory must contain 26 entries");
    });
  });
}

// Deliberate in-memory mutations prove that the validator is not a count-only
// or self-generated-golden check.
const validRevenue = {
  event_name: "ad_revenue", subject_scope: "installation_level", installation_id: "installation-test", impression_id: "impression-test",
  ad_unit_id: "unit-test", ad_network: "synthetic", amount_unscaled: "1", amount_scale: 18,
  currency: "USD", revenue_source: "server_verified",
};
if (!summaryOnly) {
  describe("semantic mutations", () => {
    it("keeps daily event counts bound to one date and one supported event", () => {
      const definitionValidator = validatorFor("urn:open-mmp:schema:metric-definition:v0.3");
      const baseline = structuredClone(fixture("42-daily-metric-date").input);
      const clickDefinition = baseline.metric_definitions.find((definition: Any) => definition.metric_name === "daily_click_count");
      check(definitionValidator(clickDefinition), "daily click definition baseline invalid");

      const missingDimension = structuredClone(clickDefinition);
      missingDimension.grouping_dimensions = missingDimension.grouping_dimensions.filter((name: string) => name !== "metric_date");
      check(!definitionValidator(missingDimension), "event_count accepted a definition without metric_date");
      check(!definitionValidator({ ...clickDefinition, event_names: ["click", "install"] }), "event_count accepted multiple event names");
      check(!definitionValidator({ ...clickDefinition, event_names: ["custom_event"] }), "event_count accepted an unsupported event name");
      check(!definitionValidator({ ...clickDefinition, grouping_dimensions: ["metric_date", "attribution_status"] }), "click event_count accepted attribution_status grouping");

      const revenue = structuredClone(fixture("33-stage-b-cohort-metrics").input.metric_definitions.find((definition: Any) => definition.metric_name === "d1_roas"));
      revenue.definition.numerator = "events";
      check(!definitionValidator(revenue), "non-event calculation accepted the events numerator");

      const missingDateEvaluation = structuredClone(baseline);
      delete missingDateEvaluation.metric_evaluations[0].grouping.metric_date;
      check(!capture(() => evaluate(missingDateEvaluation)).ok, "TypeScript event_count accepted a missing metric_date evaluation");
      check(!capture(() => pythonOutputs([missingDateEvaluation])).ok, "Python event_count accepted a missing metric_date evaluation");

      const reservedDate = structuredClone(fixture("33-stage-b-cohort-metrics").input);
      reservedDate.metric_evaluations[0].grouping.metric_date = "2026-08-01";
      check(!capture(() => evaluate(reservedDate)).ok, "TypeScript non-event calculation accepted metric_date");
      check(!capture(() => pythonOutputs([reservedDate])).ok, "Python non-event calculation accepted metric_date");
    });
    it("keeps Apple aggregate metrics qualified bucketed and receipt-date based", () => {
      const definitionValidator = validatorFor("urn:open-mmp:schema:metric-definition:v0.3");
      const baseline = structuredClone(fixture("44-apple-aggregate-metrics").input);
      const skanCount = baseline.metric_definitions.find((definition: Any) => definition.metric_name === "skan_attributed_installs");
      const distribution = baseline.metric_definitions.find((definition: Any) => definition.metric_name === "skan_conversion_value_distribution");
      check(definitionValidator(skanCount) && definitionValidator(distribution), "Apple aggregate metric definition baseline invalid");
      const wrongCalculation = structuredClone(skanCount);
      wrongCalculation.definition.calculation = "cohort_size";
      check(!definitionValidator(wrongCalculation), "aggregate metric name accepted a non-event calculation");
      check(!definitionValidator({ ...skanCount, metric_definition_version: "0.3.2" }), "aggregate metric accepted the wrong definition version");
      check(!definitionValidator({ ...skanCount, aggregation_time_zone: "Asia/Tokyo" }), "aggregate event_count accepted non-UTC aggregation");
      check(!definitionValidator({ ...skanCount, grouping_dimensions: ["metric_date", "attribution_status"] }), "aggregate event_count accepted attribution_status");
      check(!definitionValidator({ ...skanCount, grouping_dimensions: ["metric_date", "country"] }), "aggregate event_count accepted an undeclared grouping dimension");
      check(!definitionValidator({ ...skanCount, grouping_dimensions: ["metric_date", "apple_conversion_bucket"] }), "SKAN count accepted a conversion bucket");
      check(!definitionValidator({ ...distribution, grouping_dimensions: ["metric_date"] }), "SKAN distribution accepted a missing conversion bucket");
      check(!definitionValidator({ ...distribution, event_names: ["adattributionkit_postback"] }), "SKAN distribution accepted an AAK event");

      for (const [label, mutate] of [
        ["aggregate name with deterministic event", (definition: Any) => { definition.event_names = ["install"]; }],
        ["deterministic name with aggregate event", (definition: Any) => {
          definition.metric_name = "daily_synthetic_install_count";
          definition.event_names = ["skan_postback"];
        }],
        ["mixed deterministic and aggregate events", (definition: Any) => {
          definition.metric_name = "daily_synthetic_install_count";
          definition.event_names = ["install", "skan_postback"];
        }],
      ] as const) {
        const mutated = structuredClone(baseline);
        const definition = mutated.metric_definitions.find((candidate: Any) =>
          candidate.metric_name === "skan_attributed_installs");
        mutate(definition);
        const tsResult = capture(() => evaluate(mutated));
        const pyResult = capture(() => pythonOutputs([mutated]));
        check(!tsResult.ok && String(tsResult.error).includes("metric_definition_series_mismatch"),
          `TypeScript did not name the ${label} rejection`);
        check(!pyResult.ok && String(pyResult.error).includes("metric_definition_series_mismatch"),
          `Python did not name the ${label} rejection`);
      }

      const metricRunValidator = validatorFor(outputSchemaIds.metric_runs);
      const skanCountRun = baseline.metric_evaluations.length > 0
        ? fixture("44-apple-aggregate-metrics").output.metric_runs.find((run: Any) => run.metric_name === "skan_attributed_installs")
        : undefined;
      const distributionRun = fixture("44-apple-aggregate-metrics").output.metric_runs.find(
        (run: Any) => run.metric_name === "skan_conversion_value_distribution",
      );
      check(metricRunValidator(skanCountRun) && metricRunValidator(distributionRun), "Apple aggregate metric run baseline invalid");

      const countWithStatus = structuredClone(skanCountRun);
      countWithStatus.grouping.dimensions.attribution_status = "non_organic";
      check(!metricRunValidator(countWithStatus), "aggregate count run accepted attribution_status");

      const countWithBucket = structuredClone(skanCountRun);
      countWithBucket.grouping.dimensions.apple_conversion_bucket = "fine:21";
      check(!metricRunValidator(countWithBucket), "aggregate count run accepted a conversion bucket");

      const distributionWithoutBucket = structuredClone(distributionRun);
      delete distributionWithoutBucket.grouping.dimensions.apple_conversion_bucket;
      check(!metricRunValidator(distributionWithoutBucket), "distribution run accepted a missing conversion bucket");

      const distributionOutsideUtc = structuredClone(distributionRun);
      distributionOutsideUtc.aggregation_time_zone = "Asia/Tokyo";
      check(!metricRunValidator(distributionOutsideUtc), "aggregate metric run accepted non-UTC aggregation");

      const missingBucket = structuredClone(baseline);
      delete missingBucket.metric_evaluations.find((evaluation: Any) =>
        evaluation.metric_run_id_prefix === "run-44-skan-fine-21").grouping.apple_conversion_bucket;
      check(!capture(() => evaluate(missingBucket)).ok, "TypeScript SKAN distribution accepted a missing bucket");
      check(!capture(() => pythonOutputs([missingBucket])).ok, "Python SKAN distribution accepted a missing bucket");

      const signatureInvalid = structuredClone(baseline);
      signatureInvalid.records.find((record: Any) => record.record_id === "skan-fine-44").payload.signature_verified = false;
      const signatureOutput = evaluate(signatureInvalid);
      check(signatureOutput.metric_runs.find((run: Any) => run.metric_name === "skan_attributed_installs")?.value_unscaled === "1", "invalid signature contributed to SKAN count");

      for (const [label, mutate] of [
        ["losing postback", (record: Any) => { record.payload.did_win = false; }],
        ["missing source identifier", (record: Any) => { delete record.payload.source_identifier; }],
        ["missing conversion value", (record: Any) => { delete record.payload.conversion_value; }],
      ] as const) {
        const disqualified = structuredClone(baseline);
        mutate(disqualified.records.find((record: Any) => record.record_id === "skan-fine-44"));
        const output = evaluate(disqualified);
        check(
          output.metric_runs.find((run: Any) => run.metric_name === "skan_attributed_installs")?.value_unscaled === "1",
          `${label} contributed to SKAN count`,
        );
      }

      const receiptAuthority = structuredClone(baseline);
      receiptAuthority.records.find((record: Any) => record.record_id === "skan-fine-44").occurred_at = "2026-08-19T01:00:00.000Z";
      const receiptOutput = evaluate(receiptAuthority);
      check(receiptOutput.metric_runs.find((run: Any) => run.metric_name === "skan_attributed_installs")?.value_unscaled === "2", "occurred_at changed receipt-date aggregate count");
    });
    it("enforces present and undefined metric value shapes", () => {
      const validator = validatorFor(outputSchemaIds.metric_runs);
      const present = structuredClone(fixture("33-stage-b-cohort-metrics").output.metric_runs.find((run: Any) => run.metric_run_id === "run-33:d1_roas"));
      check(validator(present), "legacy present metric run is invalid");
      check(validator({ ...present, value_state: "present" }), "explicit present metric run is invalid");
      const presentWithoutValue = { ...present, value_state: "present" };
      delete presentWithoutValue.value_unscaled;
      check(!validator(presentWithoutValue), "present metric run without value was accepted");

      const undefinedRatio = structuredClone(fixture("37-undefined-organic-roas").output.metric_runs[0]);
      check(validator(undefinedRatio), "undefined ratio metric run is invalid");
      check(!validator({ ...undefinedRatio, value_unscaled: "0" }), "undefined metric run with numeric value was accepted");
      const undefinedWithoutReason = { ...undefinedRatio };
      delete undefinedWithoutReason.undefined_reason;
      check(!validator(undefinedWithoutReason), "undefined metric run without reason was accepted");

      const undefinedMoney = structuredClone(fixture("08-late-ad-revenue").output.metric_runs[0]);
      for (const field of [
        "value_unscaled", "currency", "amount_scale", "fx_rate_unscaled", "fx_rate_scale",
        "fx_rate_source", "fx_rate_as_of", "fx_rate_snapshot_id", "fx_policy_version",
      ]) delete undefinedMoney[field];
      undefinedMoney.value_state = "undefined";
      undefinedMoney.undefined_reason = "empty_cohort";
      check(validator(undefinedMoney), "undefined money metric run wrongly requires numeric or currency fields");
    });
    it("rejects empty rule bundle versions across derived artifacts", () => {
      const artifacts: Array<[keyof typeof outputSchemaIds, Any]> = [
        ["attributions", fixture("01-valid-install-referrer").output.attributions[0]],
        ["metric_runs", fixture("08-late-ad-revenue").output.metric_runs[0]],
        ["fraud_decisions", fixture("19-bot-prefetch").output.fraud_decisions[0]],
      ];
      for (const [kind, source] of artifacts) {
        const invalid = { ...source, rule_bundle_version: "" };
        check(!validatorFor(outputSchemaIds[kind])(invalid), `mutation accepted empty rule_bundle_version: ${kind}`);
      }
    });
    it("accepts the baseline revenue event", () => {
      const adValidator = validatorFor("urn:open-mmp:schema:event-ad-revenue:v0.3");
      check(adValidator(validRevenue), "mutation baseline event invalid");
    });
    it("rejects negative ad revenue", () => {
      const adValidator = validatorFor("urn:open-mmp:schema:event-ad-revenue:v0.3");
      check(!adValidator({ ...validRevenue, amount_unscaled: "-1" }), "mutation negative ad revenue was accepted");
    });
    it("rejects negative purchase and refund amounts through the common money type", () => {
      const source = fixture("16-correction-refund").input.records;
      for (const eventName of ["purchase", "refund"]) {
        const payload = source.find((record: Any) => record.event_name === eventName).payload;
        const validator = validatorFor(`urn:open-mmp:schema:event-${eventName}:v0.3`);
        check(!validator({ ...payload, amount_unscaled: "-1" }), `mutation negative ${eventName} was accepted`);
      }
    });
    it("requires access classification on every evidence reference", () => {
      const validator = validatorFor(outputSchemaIds.attributions);
      const attribution = structuredClone(fixture("01-valid-install-referrer").output.attributions[0]);
      delete attribution.evidence_refs[0].access_class;
      check(!validator(attribution), "mutation missing evidence access_class was accepted");
    });
    it("rejects short click identifiers", () => {
      const validator = validatorFor("urn:open-mmp:schema:event-click:v0.3");
      const click = structuredClone(fixture("01-valid-install-referrer").input.records.find((record: Any) => record.event_name === "click").payload);
      click.click_id = "too-short";
      check(!validator(click), "mutation short click_id was accepted");
    });
    it("rejects timestamp precision drift", () => {
      const rawValidator = validatorFor(outputSchemaIds.raw_records);
      const rawBaseline = fixture("01-valid-install-referrer").output.raw_records[0];
      check(!rawValidator({ ...rawBaseline, occurred_at: "2026-08-12T00:00:00Z" }), "mutation timestamp precision was accepted");
    });
    it("keeps platform integrity evidence closed and protected", () => {
      const fixtureValidator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      const baseline = structuredClone(fixture("46-integrity-verdict-reservation").input);
      check(fixtureValidator(baseline), `integrity fixture baseline invalid: ${ajv.errorsText(fixtureValidator.errors)}`);

      const missingEvidence = structuredClone(baseline);
      delete missingEvidence.records.find((record: Any) => record.record_id === "play-integrity-verified-46").integrity_verdict.evidence_ref;
      check(!fixtureValidator(missingEvidence), "verified integrity verdict accepted without protected evidence reference");

      const unavailableWithEvidence = structuredClone(baseline);
      unavailableWithEvidence.records.find((record: Any) => record.record_id === "app-attest-unavailable-46").integrity_verdict.evidence_ref = "protected:unexpected";
      check(!fixtureValidator(unavailableWithEvidence), "unavailable integrity verdict accepted an evidence reference");

      const unknownProvider = structuredClone(baseline);
      unknownProvider.records[0].integrity_verdict.provider = "unknown_provider";
      check(!fixtureValidator(unknownProvider), "unknown integrity provider was accepted");

      const rawValidator = validatorFor(outputSchemaIds.raw_records);
      const raw = fixture("46-integrity-verdict-reservation").output.raw_records[0];
      check(rawValidator(raw), `integrity raw-record baseline invalid: ${ajv.errorsText(rawValidator.errors)}`);
      check(!rawValidator({ ...raw, integrity_verdict: { ...raw.integrity_verdict, raw_token: "forbidden" } }), "integrity verdict accepted raw provider material");
    });
    it("detects golden output removal", () => {
      check(!equal(fixture("01-valid-install-referrer").output, { ...fixture("01-valid-install-referrer").output, raw_records: [] }), "mutation golden comparison did not fail");
    });
    it("keeps unknown events out of the registry", () => {
      check(!eventNames.includes("unknown_event"), "mutation unknown event entered registry");
    });
    it("rejects cross-tenant privacy references", () => {
      const crossTenantPrivacy = structuredClone(fixture("07-same-id-across-tenants").input);
      crossTenantPrivacy.privacy_requests.push({
        contract_version: "0.3.0",
        tenant_id: "tenant-a",
        app_id: "app-a",
        privacy_request_id: "cross-tenant-privacy",
        deletion_subject_ref: "installation:synthetic-subject",
        deletion_scope: "installation",
        requested_via: "on_device_sdk",
        requester_auth_ref: "device_auth:synthetic-cross-tenant",
        requested_at: "2026-08-12T00:00:00.000Z",
        status: "received",
        reason_code: "privacy_deletion",
        policy_version: "privacy-v1",
        affected_records: [{ record_id: "tenant-b-record", lifecycle_status: "redacted" }],
      });
      let rejected = false;
      try { evaluate(crossTenantPrivacy); } catch { rejected = true; }
      check(rejected, "mutation cross-tenant privacy reference was accepted");
    });
    it("requires privacy route and authentication provenance", () => {
      const validator = validatorFor(outputSchemaIds.privacy_requests);
      const request = structuredClone(fixture("35-privacy-request-auth-scope").output.privacy_requests[1]);
      check(validator(request), "mutation baseline on-device privacy request invalid");
      const missingAuth = structuredClone(request);
      delete missingAuth.requester_auth_ref;
      check(!validator(missingAuth), "mutation missing privacy authentication reference was accepted");
      check(!validator({ ...request, requested_via: "unknown_route" }), "mutation unknown privacy route was accepted");
      check(!validator({ ...request, deletion_scope: "app" }), "mutation on-device app deletion scope was accepted");
    });
    it("rejects an on-device request for another installation in both evaluators", () => {
      const invalid = structuredClone(fixture("35-privacy-request-auth-scope").input);
      const request = invalid.privacy_requests.find((item: Any) => item.requested_via === "on_device_sdk");
      request.deletion_subject_ref = "installation:admin-35";
      const typescript = capture(() => evaluate(invalid));
      const python = pythonBatch([invalid])[0];
      check(!typescript.ok && !python.ok, "mutation cross-installation privacy request was accepted");
    });
    it("enforces child-directed advertising-identifier boundaries", () => {
      const validator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      const baseline = structuredClone(fixture("36-child-directed-audience").input);
      check(validator(baseline), "child-directed baseline fixture is invalid");

      const forbiddenNames = [
        "advertising_id",
        "advertising_identifier",
        "google_advertising_id",
        "android_advertising_id",
        "advertising_tracking_id",
        "gaid",
        "aaid",
        "idfa",
        "rdid",
      ];
      for (const fieldName of forbiddenNames) {
        const invalid = structuredClone(baseline);
        invalid.records[0].payload.extensions = { nested: { [fieldName]: "synthetic-forbidden-value" } };
        check(!validator(invalid), `child-directed mutation ${fieldName} was accepted`);
      }

      const appleAdsObject = structuredClone(baseline);
      appleAdsObject.records[0].payload.extensions = { nested: { ad_id: "synthetic-apple-ads-object" } };
      check(validator(appleAdsObject), "Apple Ads object ad_id was treated as a device advertising identifier");

      const mixed = structuredClone(baseline);
      mixed.server_context.audience = "mixed";
      mixed.records[0].payload.extensions = { nested: { advertising_id: "synthetic-mixed-value" } };
      check(validator(mixed), "mixed-audience advertising identifier was rejected by the child-directed rule");

      const implicitGeneral = structuredClone(mixed);
      delete implicitGeneral.server_context.audience;
      check(validator(implicitGeneral), "implicit general audience did not preserve existing fixture behavior");

      const unknown = structuredClone(baseline);
      unknown.server_context.audience = "unknown";
      check(!validator(unknown), "unknown audience was accepted");
    });
    it("enforces child-directed boundaries independently in each batch", () => {
      const validator = validatorFor("urn:open-mmp:schema:fixture-input:v0.3");
      const invalid = structuredClone(fixture("07-same-id-across-tenants").input);
      invalid.batches[0].server_context.audience = "child_directed";
      invalid.batches[0].records[0].payload.extensions = {
        nested: { advertising_id: "synthetic-batch-value" },
      };
      check(!validator(invalid), "child-directed batch advertising identifier was accepted");
    });
    it("rejects cross-tenant correction references", () => {
      const crossTenantCorrection = structuredClone(fixture("16-correction-refund").input);
      crossTenantCorrection.correction_inputs[0].tenant_id = "tenant-b";
      let rejected = false;
      try { evaluate(crossTenantCorrection); } catch { rejected = true; }
      check(rejected, "mutation cross-tenant correction reference was accepted");
    });
  });
}

type TimestampCase = { name: string; field: string; value: string };
const invalidTimestamps = [
  "2026-02-30T00:00:00.000Z",
  "2026-08-12T24:00:00.000Z",
  "not-a-timestamp",
];
const timestampCases: TimestampCase[] = ["occurred_at", "redirector_click_at", "install_begin_at_server"]
  .flatMap((field) => invalidTimestamps.map((value) => ({
    name: `${field} rejects ${value}`,
    field,
    value,
  })));
const timestampStates = timestampCases.map((entry) => ({
  ...entry,
  input: capture(() => {
    const input = structuredClone(fixture("01-valid-install-referrer").input);
    if (entry.field === "occurred_at") input.records[0].occurred_at = entry.value;
    if (entry.field === "redirector_click_at") input.records.find((record: Any) => record.event_name === "click").payload.redirector_click_at = entry.value;
    if (entry.field === "install_begin_at_server") input.records.find((record: Any) => record.event_name === "install").payload.install_begin_at_server = entry.value;
    return input;
  }),
  python: undefined as PythonBatchResult | undefined,
}));
const validTimestampStates = timestampStates.filter((state) => state.input.ok);
const pythonTimestampBatch = capture(() => pythonBatch(
  validTimestampStates.map((state) => capturedValue(state.input, state.name)),
));
if (pythonTimestampBatch.ok) {
  pythonTimestampBatch.value.forEach((result, index) => {
    const state = validTimestampStates[index];
    if (state) state.python = result;
  });
}
if (!summaryOnly) {
  describe("timestamp validation", () => {
    for (const entry of timestampStates) {
      it(entry.name, () => {
        const input = capturedValue(entry.input, `timestamp fixture preparation failed: ${entry.name}`);
      const schemaRejected = entry.field === "occurred_at"
        ? !validatorFor("urn:open-mmp:schema:fixture-input:v0.3")(input)
        : (() => {
            const eventName = entry.field === "redirector_click_at" ? "click" : "install";
            const record = input.records.find((candidate: Any) => candidate.event_name === eventName);
            const validator = validatorFor(`urn:open-mmp:schema:event-${eventName}:v0.3`);
            return !validator({ ...record.payload, event_name: eventName });
          })();
      if (entry.field === "occurred_at") {
        if (entry.value !== "not-a-timestamp") {
          check(!schemaRejected, "ingress syntax schema rejected the calendar-invalid timestamp before formal evaluation");
        } else {
          check(schemaRejected, `ingress syntax schema accepted malformed ${entry.field}`);
        }
        const output = evaluate(input);
        check(output.deliveries[0].reason_code === "timestamp_invalid", "TypeScript did not emit timestamp_invalid delivery");
        check(output.rejections[0].reason_code === "timestamp_invalid" && output.rejections[0].payload_disposition === "discarded", "TypeScript did not emit the formal timestamp rejection");
        check(entry.python?.ok && equal(output, entry.python.output), "Python did not match the formal timestamp rejection");
        return;
      }
      check(schemaRejected, `schema accepted invalid ${entry.field}`);
      let failure: { name: string; message: string; exit_code: number } | undefined;
      try {
        evaluate(input);
      } catch (error) {
        check(error instanceof TimestampInvalidError, `unexpected TypeScript error for ${entry.field}`);
        failure = { name: error.name, message: error.message, exit_code: error.exitCode };
      }
      check(failure, `TypeScript accepted invalid ${entry.field}`);
      check(pythonTimestampBatch.ok, "Python timestamp batch failed");
      const python = entry.python;
      check(python, `Python timestamp result missing: ${entry.name}`);
      check(!python.ok, `Python accepted invalid ${entry.field}`);
      check(equal(failure, python.error), `timestamp rejection mismatch for ${entry.field}`);
    });
  }
  });
}

const unicodeValues = ["\u{10000}campaign", "campaign", "\uE000campaign"];
if (!summaryOnly) {
  describe("UTF-16 output ordering", () => {
    it("matches the independent Python evaluator for astral text", () => {
      const unicodeInput = structuredClone(fixture("01-valid-install-referrer").input);
      const unicodeReconciliation = unicodeInput.reconciliation_inputs[0];
      const unicodeKey = unicodeReconciliation.matching_keys[0];
      unicodeReconciliation.matching_keys = unicodeValues.map((value) => ({ ...unicodeKey, value }));
      unicodeReconciliation.candidates[0].matching_keys = unicodeValues.map((value) => ({ ...unicodeKey, value }));
      const unicodeTypeScript = evaluate(unicodeInput);
      const [unicodePython] = pythonOutputs([unicodeInput]);
      check(equal(unicodeTypeScript, unicodePython), "UTF-16 cross-language mismatch");
      check(equal(
        unicodeTypeScript.reconciliation[0].matching_keys.map((entry: Any) => entry.value),
        ["campaign", "\u{10000}campaign", "\uE000campaign"],
      ), "UTF-16 matching-key order");
    });
  });
}

function shuffled<T>(values: T[], seed: number): T[] {
  const output = [...values];
  let state = seed >>> 0;
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

function permutedInput(input: Any, seed: number): Any {
  const output = structuredClone(input);
  if (output.records) output.records = shuffled(output.records, seed);
  if (output.batches) {
    output.batches = shuffled(output.batches, seed);
    output.batches.forEach((batch: Any, index: number) => {
      batch.records = shuffled(batch.records, seed + index + 1);
    });
  }
  return output;
}

const permutationCases = fixtureStates.flatMap((state, fixtureIndex) =>
  Array.from({ length: 5 }, (_, permutationIndex) => {
    return {
      name: `${state.name} permutation ${permutationIndex + 1}`,
      expected: state.first,
      input: capture(() => permutedInput(
        capturedValue(state.input, `permutation input missing: ${state.name}`),
        (fixtureIndex + 1) * 1_000 + permutationIndex + 1,
      )),
      python: undefined as PythonBatchResult | undefined,
    };
  }),
);
const validPermutationCases = permutationCases.filter((entry) => entry.input.ok);
const permutationPythonBatch = capture(() => pythonBatch(
  validPermutationCases.map((entry) => capturedValue(entry.input, entry.name)),
));
if (permutationPythonBatch.ok) {
  permutationPythonBatch.value.forEach((result, index) => {
    const entry = validPermutationCases[index];
    if (entry) entry.python = result;
  });
}
if (!summaryOnly) {
  describe("input permutations", () => {
    for (const entry of permutationCases) {
      it(entry.name, () => {
        const input = capturedValue(entry.input, `permutation preparation failed: ${entry.name}`);
        const expected = capturedValue(entry.expected, `permutation baseline failed: ${entry.name}`);
        const output = evaluate(input);
        check(equal(output, expected), `TypeScript permutation changed output: ${entry.name}`);
        check(permutationPythonBatch.ok, "Python permutation batch failed");
        check(entry.python, `Python permutation result missing: ${entry.name}`);
        check(entry.python.ok, `Python permutation failed: ${entry.name}`);
        check(equal(output, entry.python.output), `Python permutation mismatch: ${entry.name}`);
      });
    }
  }
  );
}

export function validationSummary(): string {
  return `Validated ${schemaPaths.length} schemas, ${Object.keys(registryPaths).length} registries, ${fixtureDirs.length} reviewed fixtures, ${outputArtifactCount} golden output artifacts, ${scenarios.length} scenario assertions, ${acceptance.length} acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.`;
}

if (summaryOnly) console.log(validationSummary());
