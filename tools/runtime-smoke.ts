import { readFileSync } from "node:fs";
import { expectedMaxTokenAll } from "../apps/api/src/max-receiver.js";

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
const port = process.env.OPENMMP_API_HOST_PORT ?? env.OPENMMP_API_HOST_PORT ?? "8080";
const base = `http://127.0.0.1:${port}`;
const health = await fetch(`${base}/health`);
if (!health.ok) throw new Error(`health smoke failed with ${health.status}`);
const parameters = new URLSearchParams({
  event_id: "abcdef0123456789abcdef0123456789abcdef02",
  revenue: "0.000001",
  ts: "1787097600",
  ad_unit_id: "synthetic-smoke-unit",
  network: "synthetic-smoke-network",
  cc: "US",
});
parameters.set("event_token_all", expectedMaxTokenAll(parameters, required("OPENMMP_MAX_EVENT_KEY")));
const path = `/v1/ingest/max/${required("OPENMMP_MAX_PATH_SECRET")}`;
const accepted = await fetch(`${base}${path}?${parameters}`);
if (accepted.status !== 204) throw new Error(`valid MAX smoke returned ${accepted.status}`);
parameters.set("event_token_all", "0".repeat(64));
const tampered = await fetch(`${base}${path}?${parameters}`);
if (tampered.status !== 401) throw new Error(`tampered MAX smoke returned ${tampered.status}`);
console.log("Runtime smoke passed: health=200 valid_max=204 tampered_max=401.");
