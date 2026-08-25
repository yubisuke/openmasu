import { readFileSync } from "node:fs";
import { expectedMaxTokenAll } from "../apps/api/src/max-receiver.js";
import { signSdkRequest } from "../apps/api/src/sdk-auth.js";
import { randomBytes } from "node:crypto";

function readRepositoryEnv(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "ENOENT") return {};
    throw error;
  }
}

const env = readRepositoryEnv();
const required = (name: string): string => {
  const value = process.env[name] ?? env[name];
  if (!value) throw new Error(`missing runtime smoke variable ${name}`);
  return value;
};
const port = process.env.OPENMASU_API_HOST_PORT ?? env.OPENMASU_API_HOST_PORT ?? "8080";
const base = `http://127.0.0.1:${port}`;
const redirectorPort = process.env.OPENMASU_REDIRECTOR_HOST_PORT ?? env.OPENMASU_REDIRECTOR_HOST_PORT ?? "8090";
const redirectorBase = process.env.OPENMASU_REDIRECTOR_BASE_URL ?? env.OPENMASU_REDIRECTOR_BASE_URL
  ?? `http://127.0.0.1:${redirectorPort}`;
const health = await fetch(`${base}/health`);
if (!health.ok) throw new Error(`health smoke failed with ${health.status}`);
const dashboardLoginPage = await fetch(`${base}/dashboard`);
const dashboardLoginBody = await dashboardLoginPage.text();
if (dashboardLoginPage.status !== 200 || !dashboardLoginBody.includes("Admin key") || dashboardLoginBody.includes("Cohort metrics")) {
  throw new Error(`unauthenticated dashboard smoke returned ${dashboardLoginPage.status}`);
}
const unauthenticatedData = await fetch(`${base}/dashboard/apps/app-local`);
if (unauthenticatedData.status !== 401) {
  throw new Error(`unauthenticated dashboard data route returned ${unauthenticatedData.status}`);
}
const dashboardLogin = await fetch(`${base}/dashboard/session`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ admin_key: required("OPENMASU_ADMIN_KEY") }),
});
const dashboardCookie = (dashboardLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];
if (dashboardLogin.status !== 303 || !dashboardCookie) {
  throw new Error(`dashboard login smoke returned ${dashboardLogin.status}`);
}
const dashboardHome = await fetch(`${base}/dashboard`, { headers: { cookie: dashboardCookie } });
if (dashboardHome.status !== 200 || !(await dashboardHome.text()).includes("OpenMasu dashboard")) {
  throw new Error(`authenticated dashboard smoke returned ${dashboardHome.status}`);
}
const configuredAppId = required("OPENMASU_MAX_APP_ID");
const dashboardApp = await fetch(`${base}/dashboard/apps/${encodeURIComponent(configuredAppId)}`, {
  headers: { cookie: dashboardCookie },
});
const dashboardAppBody = await dashboardApp.text();
if (dashboardApp.status !== 200 || !/data-value-unscaled="-?[0-9]+"/.test(dashboardAppBody)) {
  throw new Error(`seeded dashboard metric smoke returned ${dashboardApp.status}`);
}
const parameters = new URLSearchParams({
  event_id: "abcdef0123456789abcdef0123456789abcdef02",
  revenue: "0.000001",
  ts: "1787097600",
  ad_unit_id: "synthetic-smoke-unit",
  network: "synthetic-smoke-network",
  cc: "US",
});
parameters.set("event_token_all", expectedMaxTokenAll(parameters, required("OPENMASU_MAX_EVENT_KEY")));
const path = `/v1/ingest/max/${required("OPENMASU_MAX_PATH_SECRET")}`;
const accepted = await fetch(`${base}${path}?${parameters}`);
if (accepted.status !== 204) throw new Error(`valid MAX smoke returned ${accepted.status}`);
parameters.set("event_token_all", "0".repeat(64));
const tampered = await fetch(`${base}${path}?${parameters}`);
if (tampered.status !== 401) throw new Error(`tampered MAX smoke returned ${tampered.status}`);

const linkResponse = await fetch(`${base}/v1/admin/tracking-links`, {
  method: "POST",
  headers: { authorization: `Bearer ${required("OPENMASU_ADMIN_KEY")}`, "content-type": "application/json" },
  body: JSON.stringify({
    app_id: configuredAppId,
    destination_kind: "play_store",
    destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
    play_package_name: "dev.openmasu.synthetic",
    campaign_id: "campaign-runtime-smoke",
  }),
});
if (linkResponse.status !== 201) throw new Error(`tracking-link smoke returned ${linkResponse.status}`);
const link = await linkResponse.json() as { slug: string };
const redirected = await fetch(`${redirectorBase}/r/${link.slug}?destination=https://attacker.invalid`, {
  redirect: "manual", headers: { "user-agent": "Synthetic Android" },
});
if (redirected.status !== 302 || !redirected.headers.get("location")?.startsWith("https://play.google.com/")) {
  throw new Error(`redirector smoke returned ${redirected.status}`);
}

const sdkKeyId = required("OPENMASU_SDK_KEY_ID");
const sdkSecret = required("OPENMASU_SDK_KEY");
const signedPost = async (path: string, value: unknown, installation?: { keyId: string; secret: string }): Promise<Response> => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const timestampMs = Date.now();
  const nonce = randomBytes(18).toString("base64url");
  const installationKeyId = installation?.keyId;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-sdk-key-id": sdkKeyId,
      "x-openmasu-installation-key-id": installationKeyId ?? "-",
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,
      "x-openmasu-signature": signSdkRequest(installation?.secret ?? sdkSecret, {
        method: "POST", path, sdkKeyId, installationKeyId, timestampMs, nonce, body,
      }),
    },
    body,
  });
};
const smokeId = randomBytes(8).toString("hex");
const installationId = `installation:runtime-smoke-${smokeId}`;
const enrolled = await signedPost("/v1/installations", { installation_id: installationId });
if (enrolled.status !== 201) throw new Error(`installation enrollment smoke returned ${enrolled.status}`);
const credential = await enrolled.json() as { installation_key_id: string; installation_secret: string };
const batch = await signedPost("/v1/events/batch", { records: [{
  producer_version: "runtime-smoke",
  event_id: `event:runtime-smoke-session-${smokeId}`,
  event_name: "session_start",
  occurred_at: new Date().toISOString(),
  occurred_at_source: "device",
  processing_purpose_id: "analytics",
  processing_sequence: 1,
  payload: { event_name: "session_start", installation_id: installationId, session_id: `session:runtime-smoke-${smokeId}` },
}] }, { keyId: credential.installation_key_id, secret: credential.installation_secret });
if (batch.status !== 202) throw new Error(`signed SDK batch smoke returned ${batch.status}`);

console.log("Runtime smoke passed: health=200 dashboard=200/login303 seeded_metric=visible valid_max=204 tampered_max=401 redirect=302 enrollment=201 sdk_batch=202.");
