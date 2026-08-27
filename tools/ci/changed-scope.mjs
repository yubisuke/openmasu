import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ALL = Object.freeze({ contract: true, runtime: true, android: true, android_emulator: true, ios: true });

function normalized(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function classifyPaths(inputPaths) {
  const result = { contract: false, runtime: false, android: false, android_emulator: false, ios: false };
  const markAll = () => Object.assign(result, ALL);
  for (const rawPath of inputPaths) {
    const path = normalized(rawPath.trim());
    if (!path) continue;
    let matched = false;
    if (path === "README.md" || path === "CONTRIBUTING.md" || path === "SECURITY.md"
      || path === "NOTICE" || path === "LICENSE" || path === "AGENTS.md" || path.startsWith("docs/")) {
      result.contract = true;
      matched = true;
    }
    if (path.startsWith("apps/") || path.startsWith("db/") || path.startsWith("runtime-schemas/")
      || path.startsWith("config/") || ["compose.yaml", "Dockerfile", ".dockerignore", ".env.example"].includes(path)) {
      result.runtime = true;
      matched = true;
    }
    if (path.startsWith("packages/")) {
      result.contract = true;
      result.runtime = true;
      matched = true;
    }
    if (["schemas/", "registries/", "fixtures/", "spec/", "examples/"].some((prefix) => path.startsWith(prefix))) {
      result.contract = true;
      result.runtime = true;
      matched = true;
    }
    if (path.startsWith("sdk/android/")) {
      result.contract = true;
      result.android = true;
      result.android_emulator = true;
      matched = true;
    } else if (path.startsWith("sdk/ios/")) {
      result.contract = true;
      result.android = true;
      result.ios = true;
      matched = true;
    } else if (path.startsWith("sdk/")) {
      result.contract = true;
      result.android = true;
      result.ios = true;
      matched = true;
    }
    if (path.startsWith("tools/") || path.startsWith("sbom/") || path.startsWith(".github/")
      || ["package.json", "package-lock.json", ".npmrc", ".nvmrc", "tsconfig.json", "requirements-contract.txt"].includes(path)) {
      markAll();
      matched = true;
    }
    if (!matched) markAll();
  }
  return result;
}

function allScopes(reason) {
  process.stderr.write(`CI scope detection is running every gate: ${reason}\n`);
  return { ...ALL };
}

function detect() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "local";
  if (eventName !== "pull_request") return allScopes(`event=${eventName}`);
  const base = process.env.OPENMASU_CI_BASE_SHA ?? "";
  const head = process.env.OPENMASU_CI_HEAD_SHA ?? "";
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    return allScopes("pull request revisions are unavailable");
  }
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths = output.split(/\r?\n/).filter(Boolean);
    if (paths.length === 0) return allScopes("the pull request diff is empty");
    return classifyPaths(paths);
  } catch {
    return allScopes("git diff failed");
  }
}

function emit(scopes) {
  const entries = Object.entries(scopes).map(([name, value]) => `run_${name}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, entries, "utf8");
  process.stdout.write(`${JSON.stringify(scopes)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  emit(detect());
}
