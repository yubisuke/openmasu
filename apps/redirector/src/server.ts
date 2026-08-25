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
  classify(key: string): "normal" | "elevated" | "saturated" {
    const current = this.buckets.get(key);
    if (!current) return "normal";
    if (current.tokens < 1) return "saturated";
    return current.tokens < Math.max(2, this.burst / 4) ? "elevated" : "normal";
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
  clientClassEnabled: process.env.OPENMASU_REDIRECTOR_CLIENT_CLASS !== "off",
  remoteClickParameter: process.env.OPENMASU_REDIRECTOR_REMOTE_CLICK_PARAM ?? "cid",
  hostMode: process.env.OPENMASU_REDIRECTOR_LINK_HOST_MODE === "fixed_tenant" ? "fixed_tenant" : "host_header",
  referrerMaximumEncodedCharacters: Number(process.env.OPENMASU_REFERRER_MAX_ENCODED_CHARS ?? "512"),
  wellKnownCacheSeconds: Number(process.env.OPENMASU_WELLKNOWN_CACHE_SECONDS ?? "300"),
  wellKnownMaximumBytes: Number(process.env.OPENMASU_WELLKNOWN_MAX_BYTES ?? "65536"),
  wellKnownLimiter: new BoundedIpBucket(
    Number(process.env.OPENMASU_WELLKNOWN_RATE_RPS ?? "5"),
    Number(process.env.OPENMASU_WELLKNOWN_RATE_BURST ?? "20"),
  ),
  limiter: new BoundedIpBucket(
    Number(process.env.OPENMASU_REDIRECTOR_RATE_RPS ?? "20"),
    Number(process.env.OPENMASU_REDIRECTOR_RATE_BURST ?? "50"),
  ),
}));

server.listen(port, "0.0.0.0", () => {
  process.stdout.write('{"event":"service_started","component":"redirector"}\n');
});
