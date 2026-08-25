import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const arguments_ = process.argv.slice(2);
const builtRootIndex = arguments_.indexOf("--built-root");
const builtRoot = builtRootIndex >= 0 ? resolve(arguments_[builtRootIndex + 1] ?? "") : undefined;

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function filesUnder(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const name of readdirSync(directory)) {
    const value = join(directory, name);
    if (statSync(value).isDirectory()) result.push(...filesUnder(value, predicate));
    else if (predicate(value)) result.push(value);
  }
  return result.sort();
}
function digest(data) { return createHash("sha256").update(data).digest("hex"); }
function symbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])_?${escaped}(?:$|[^A-Za-z0-9])`, "m");
}

const manifestPath = join(root, "sdk", "ios", "Sources", "OpenMasuCore", "PrivacyInfo.xcprivacy");
const manifest = readFileSync(manifestPath, "utf8");
check(/<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(manifest), "NSPrivacyTracking must be false");
check(!manifest.includes("NSPrivacyTrackingDomains"), "NSPrivacyTrackingDomains must be absent");
check(/<key>NSPrivacyAccessedAPITypes<\/key>\s*<array\/>/.test(manifest), "Required Reason API declarations must be empty when the audit is empty");
for (const value of [
  "NSPrivacyCollectedDataTypeDeviceID",
  "NSPrivacyCollectedDataTypeProductInteraction",
  "NSPrivacyCollectedDataTypePurchaseHistory",
  "NSPrivacyCollectedDataTypeAdvertisingData",
  "NSPrivacyCollectedDataTypePurposeAnalytics",
  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
  "NSPrivacyCollectedDataTypePurposeDeveloperAdvertising",
]) check(manifest.includes(value), `privacy manifest is missing ${value}`);

const symbols = JSON.parse(readFileSync(join(root, "sdk", "ios", "privacy-symbols.json"), "utf8"));
const packageText = readFileSync(join(root, "sdk", "ios", "Package.swift"), "utf8");
check(!packageText.includes(".package("), "shipping iOS package gained a third-party dependency");
const resolvedPath = join(root, "sdk", "ios", "Package.resolved");
if (existsSync(resolvedPath)) {
  const resolved = JSON.parse(readFileSync(resolvedPath, "utf8"));
  check(Array.isArray(resolved.pins) && resolved.pins.length === 0, "shipping iOS package resolved a runtime dependency");
}
check(!packageText.includes("AdSupport") && !packageText.includes("AppTrackingTransparency"), "shipping iOS package links a forbidden tracking framework");
check(packageText.includes('.process("PrivacyInfo.xcprivacy")'), "privacy manifest is not declared as a Swift package resource");

const sourceFiles = [
  ...filesUnder(join(root, "sdk", "ios", "Sources"), (path) => /\.(swift|h|m|mm)$/.test(path)),
  ...filesUnder(join(root, "sdk", "ios", "Sample"), (path) => /\.swift$/.test(path)),
  ...filesUnder(join(root, "sdk", "unity", "com.openmasu.sdk", "Runtime"), (path) => /\.(swift|h|m|mm|cs)$/.test(path)),
];
const sourceText = sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n");
for (const value of symbols.forbidden_symbols) check(!sourceText.includes(value), `forbidden source symbol found: ${value}`);
for (const entry of symbols.required_reason_apis) {
  for (const value of entry.symbols) check(!symbolPattern(value).test(sourceText), `Required Reason source symbol found without declaration: ${entry.category}/${value}`);
}

const originalSources = join(root, "sdk", "ios", "Sources");
const vendoredSources = join(root, "sdk", "unity", "com.openmasu.sdk", "Runtime", "Plugins", "iOS", "Sources");
const originalFiles = filesUnder(originalSources).map((path) => relative(originalSources, path).replaceAll("\\", "/"));
const vendoredFiles = filesUnder(vendoredSources).map((path) => relative(vendoredSources, path).replaceAll("\\", "/"));
check(JSON.stringify(originalFiles) === JSON.stringify(vendoredFiles), "Unity vendored Swift source inventory differs from sdk/ios");
for (const name of originalFiles) {
  const original = readFileSync(join(originalSources, name));
  const vendored = readFileSync(join(vendoredSources, name));
  check(digest(original) === digest(vendored), `Unity vendored Swift source differs: ${name}`);
}
check(
  digest(readFileSync(manifestPath)) === digest(readFileSync(join(root, "sdk", "unity", "com.openmasu.sdk", "Runtime", "Plugins", "iOS", "PrivacyInfo.xcprivacy"))),
  "Unity root privacy manifest differs from the Swift package manifest"
);

const schemaPath = join(root, "sdk", "ios", "Sources", "OpenMasuApplePostback", "Resources", "conversion-schema-v1.json");
const fixture = JSON.parse(readFileSync(join(root, "fixtures", "v0.4", "45-ios-conversion-schema", "input.json"), "utf8"));
const install = fixture.records.find((record) => record.event_name === "install");
check(install?.payload?.extensions?.conversion_schema_sha256 === digest(readFileSync(schemaPath)), "fixture 45 conversion schema digest differs from the bundled schema");

const sbom = JSON.parse(readFileSync(join(root, "sbom", "sdk-ios.cdx.json"), "utf8"));
check(sbom.bomFormat === "CycloneDX", "iOS SBOM is not CycloneDX");
check(Array.isArray(sbom.components) && sbom.components.length === 0, "iOS runtime dependency list must be empty");
check(Array.isArray(sbom.dependencies) && sbom.dependencies.every((entry) => Array.isArray(entry.dependsOn) && entry.dependsOn.length === 0), "iOS SBOM dependency graph must be empty");

let builtObjectCount = 0;
if (builtRoot) {
  check(existsSync(builtRoot), `built root does not exist: ${builtRoot}`);
  const builtManifests = filesUnder(builtRoot, (path) => path.endsWith("PrivacyInfo.xcprivacy"));
  check(builtManifests.length > 0, "PrivacyInfo.xcprivacy is absent from the built product");
  for (const builtManifest of builtManifests) {
    check(digest(readFileSync(builtManifest)) === digest(readFileSync(manifestPath)), `built privacy manifest differs: ${builtManifest}`);
  }
  const targetMarkers = ["OpenMasuCore.build", "OpenMasuAppleAds.build", "OpenMasuApplePostback.build", "OpenMasuMax.build", "OpenMasuObjC.build"];
  const objects = filesUnder(builtRoot, (path) => path.endsWith(".o") && targetMarkers.some((marker) => path.includes(marker)));
  check(objects.length > 0, "no shipping iOS object files found for symbol audit");
  builtObjectCount = objects.length;
  let undefinedSymbols = "";
  for (const object of objects) {
    const result = spawnSync("xcrun", ["nm", "-u", object], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    check(result.status === 0, `nm failed for ${object}: ${result.stderr || result.stdout}`);
    undefinedSymbols += `${result.stdout}\n`;
  }
  for (const entry of symbols.required_reason_apis) {
    for (const value of entry.symbols) check(!symbolPattern(value).test(undefinedSymbols), `Required Reason binary symbol found without declaration: ${entry.category}/${value}`);
  }
  for (const value of symbols.forbidden_symbols) check(!symbolPattern(value).test(undefinedSymbols), `forbidden binary symbol found: ${value}`);
}

console.log(`iOS SDK audit passed: ${sourceFiles.length} source files, ${originalFiles.length} vendored files, empty runtime SBOM, ${builtObjectCount} built objects.`);
