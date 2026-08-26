import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const json = <T>(path: string): T => JSON.parse(read(path)) as T;

const android = read("sdk/android/build.gradle.kts");
const androidMatch = android.match(/^version = "([^"]+)"$/m);
assert.ok(androidMatch, "Android SDK release version is missing");
const releaseVersion = androidMatch[1];
assert.equal(
  json<{ version: string }>("sdk/unity/com.openmasu.sdk/package.json").version,
  releaseVersion,
  "Android and Unity SDK release versions differ",
);

for (const path of [
  "sdk/android/core/src/main/java/dev/openmasu/sdk/OpenMasuStorage.kt",
  "sdk/android/sample/build.gradle.kts",
  "sdk/ios/Sources/OpenMasuCore/Models.swift",
  "sdk/ios/Sources/OpenMasuObjC/OpenMasuObjCBridge.swift",
  "sdk/unity/com.openmasu.sdk/Runtime/OpenMasu.androidlib/build.gradle",
  "sdk/unity/com.openmasu.sdk/Runtime/OpenMasu.androidlib/src/main/java/dev/openmasu/unity/OpenMasuUnityBridge.java",
  "sdk/unity/com.openmasu.sdk/Runtime/OpenMasuClient.cs",
  "sdk/unity/com.openmasu.sdk/Runtime/Plugins/iOS/Sources/OpenMasuCore/Models.swift",
  "sdk/unity/com.openmasu.sdk/Runtime/Plugins/iOS/Sources/OpenMasuObjC/OpenMasuObjCBridge.swift",
  "tools/build-sdk-release.py",
  "tools/sbom.ts",
]) {
  assert.ok(read(path).includes(releaseVersion), `${path} does not carry ${releaseVersion}`);
}

const bundlePath = `build/sdk-release/openmasu-sdk-${releaseVersion}`;
for (const path of [
  ".github/workflows/sdk-android.yml",
  "README.md",
  "docs/operations/release.md",
  "package.json",
  "sdk/unity/README.md",
]) {
  assert.ok(read(path).includes(bundlePath), `${path} does not reference ${bundlePath}`);
}
assert.ok(read("sdk/ios/README.md").includes(`\`${releaseVersion}\``), "iOS release identity differs");
assert.ok(read(`docs/releases/v${releaseVersion}.md`).includes(`# OpenMasu v${releaseVersion}`), "release notes differ");

for (const path of ["package.json", "packages/contracts/package.json", "packages/attribution-core/package.json"]) {
  assert.equal(json<{ version: string }>(path).version, "0.4.0", `${path} changed the Contract v0.4 package identity`);
}

console.log(`Verified OpenMasu source/SDK release ${releaseVersion} with Contract v0.4 identity unchanged.`);
