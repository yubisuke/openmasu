import { createServer } from "node:http";
import { createAppPool, EncryptedFilePayloadStore, EnvironmentSecretStore } from "@openmasu/runtime";
import { createRedirectorHandler } from "./handler.js";

class BoundedIpBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly rate: number, private readonly burst: number, private readonly maximum = 10_000) {}
  allow(key: string): boolean {
    const now = performance.now();
    const current = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    current.tokens = Math.min(this.burst, current.tokens + Math.max(0, now - current.at) / 1000 * this.rate);
    current.at = now;
    const allowed = current.tokens >= 1;
    if (allowed) current.tokens -= 1;
    this.buckets.delete(key);
    this.buckets.set(key, current);
    while (this.buckets.size > this.maximum) this.buckets.delete(this.buckets.keys().next().value!);
    return allowed;
  }
}

const port = Number(process.env.OPENMASU_REDIRECTOR_PORT ?? "8090");
const secrets = new EnvironmentSecretStore({
  OPENMASU_PAYLOAD_MASTER_KEY: { value: process.env.OPENMASU_PAYLOAD_MASTER_KEY, file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE },
});
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads",
  secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"),
);
const geoMode = process.env.OPENMASU_REDIRECTOR_GEO ?? "off";
if (geoMode !== "off" && geoMode !== "country") throw new Error("OPENMASU_REDIRECTOR_GEO must be off or country");
const server = createServer(createRedirectorHandler({
  pool: createAppPool(),
  payloadStore,
  tenantId: process.env.OPENMASU_REDIRECTOR_TENANT_ID ?? "tenant-local",
  fallbackUrl: process.env.OPENMASU_REDIRECTOR_FALLBACK_URL ?? "https://play.google.com/store",
  geoMode,
  limiter: new BoundedIpBucket(
    Number(process.env.OPENMASU_REDIRECTOR_RATE_RPS ?? "20"),
    Number(process.env.OPENMASU_REDIRECTOR_RATE_BURST ?? "50"),
  ),
}));

server.listen(port, "0.0.0.0", () => {
  process.stdout.write('{"event":"service_started","component":"redirector"}\n');
});
