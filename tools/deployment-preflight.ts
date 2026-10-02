import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SingleHostConfiguration {
  format: "openmasu-single-host-v1";
  release_tag: string;
  compose_project: string;
  api_origin: string;
  redirector_origin: string;
  destination_origins: string[];
  tls_termination: "operator_reverse_proxy";
  certificate_kind: "public_ca";
}
const fields = ["format", "release_tag", "compose_project", "api_origin", "redirector_origin", "destination_origins", "tls_termination", "certificate_kind"];
export const deploymentSecretNames = [
  "OPENMASU_ADMIN_KEY", "OPENMASU_PAYLOAD_MASTER_KEY", "OPENMASU_SDK_KEY",
  "OPENMASU_INSTALLATION_DIGEST_KEY", "OPENMASU_MAX_EVENT_KEY", "OPENMASU_MAX_PATH_SECRET",
  "OPENMASU_POSTGRES_BOOTSTRAP_PASSWORD", "OPENMASU_APP_DATABASE_PASSWORD",
  "OPENMASU_READER_DATABASE_PASSWORD", "OPENMASU_SEED_DATABASE_PASSWORD",
] as const;

function publicOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost") && !isIP(url.hostname);
  } catch { return false; }
}
export function deploymentConfigurationReasons(input: unknown, releaseVersion: string): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["configuration_invalid"];
  const config = input as SingleHostConfiguration;
  if (Object.keys(config).length !== fields.length || fields.some((key) => !(key in config))) return ["configuration_invalid"];
  const reasons: string[] = [];
  if (config.format !== "openmasu-single-host-v1") reasons.push("configuration_invalid");
  if (config.release_tag !== `v${releaseVersion}`) reasons.push("release_unsupported");
  if (typeof config.compose_project !== "string" || !/^openmasu-[a-z][a-z0-9-]{1,48}$/.test(config.compose_project)
    || /^openmasu-(?:synthetic|pilot)/.test(config.compose_project)) reasons.push("project_scope_invalid");
  if (!publicOrigin(config.api_origin) || !publicOrigin(config.redirector_origin) || config.api_origin === config.redirector_origin) reasons.push("public_url_invalid");
  if (!Array.isArray(config.destination_origins) || config.destination_origins.length === 0) reasons.push("destination_allowlist_empty");
  else if (config.destination_origins.length > 100 || config.destination_origins.some((entry) => !publicOrigin(entry)) || new Set(config.destination_origins).size !== config.destination_origins.length) reasons.push("destination_allowlist_invalid");
  if (config.tls_termination !== "operator_reverse_proxy" || config.certificate_kind !== "public_ca") reasons.push("development_tls_forbidden");
  return reasons;
}
export function parsePrivateRuntimeEnvironment(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error("runtime_environment_invalid");
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/.test(name) || name in result) throw new Error("runtime_environment_invalid");
    result[name] = line.slice(separator + 1);
  }
  return result;
}
export function deploymentPreflight(input: unknown, environment: Readonly<Record<string, string>>, releaseVersion: string): {
  status: "ready" | "refused"; reasons: string[]; scope: "single_host_configuration"; tls_verified: false; production_verified: false;
} {
  const reasons = deploymentConfigurationReasons(input, releaseVersion);
  if (reasons.length === 0) {
    const config = input as SingleHostConfiguration;
    if (environment.OPENMASU_PUBLIC_BASE_URL !== config.api_origin || environment.OPENMASU_REDIRECTOR_BASE_URL !== config.redirector_origin) reasons.push("runtime_public_url_mismatch");
    const actual = (environment.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...config.destination_origins].sort())) reasons.push("runtime_allowlist_mismatch");
    if (deploymentSecretNames.some((name) => !environment[name])) reasons.push("required_secret_missing");
    else if (deploymentSecretNames.some((name) => Buffer.byteLength(environment[name]) < 32 || /^(?:synthetic|example|change-me|placeholder)/i.test(environment[name]))) reasons.push("required_secret_unsafe");
  }
  return { status: reasons.length ? "refused" : "ready", reasons, scope: "single_host_configuration", tls_verified: false, production_verified: false };
}

export function deploymentReleaseVersion(): string {
  return JSON.parse(readFileSync("sdk/unity/com.openmasu.sdk/package.json", "utf8")).version;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = new Map<string, string>();
    for (const argument of process.argv.slice(2)) {
      const match = /^--(config|runtime-env)=(.+)$/.exec(argument);
      if (!match || args.has(match[1])) throw new Error("arguments_invalid");
      args.set(match[1], match[2]);
    }
    if (args.size !== 2) throw new Error("arguments_invalid");
    const config = JSON.parse(readFileSync(args.get("config")!, "utf8"));
    const env = parsePrivateRuntimeEnvironment(readFileSync(args.get("runtime-env")!, "utf8"));
    const result = deploymentPreflight(config, env, deploymentReleaseVersion());
    if (result.status === "ready") {
      const git = (values: string[]) => execFileSync("git", values, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (git(["cat-file", "-t", config.release_tag]) !== "tag" || git(["rev-parse", `${config.release_tag}^{commit}`]) !== git(["rev-parse", "HEAD"]) || git(["status", "--porcelain"])) throw new Error("release_identity_mismatch");
    }
    console.log(JSON.stringify(result));
    if (result.status !== "ready") process.exitCode = 2;
  } catch (error) {
    const reason = error instanceof Error && /^(arguments_invalid|runtime_environment_invalid|release_identity_mismatch)$/.test(error.message) ? error.message : "deployment_preflight_failed";
    console.error(JSON.stringify({ status: "refused", reasons: [reason], tls_verified: false, production_verified: false })); process.exitCode = 2;
  }
}
