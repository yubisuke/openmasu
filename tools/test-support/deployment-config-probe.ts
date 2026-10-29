// Synthetic-only proof inside the existing disposable Compose pilot.
import assert from "node:assert/strict";
import { createAppPool } from "@openmasu/runtime";
import { csrfToken } from "../../apps/api/src/session.js";

const pool = createAppPool();
try {
  assert.equal((await pool.query("SELECT purpose FROM control.deployment_purpose WHERE singleton")).rows[0]?.purpose, "synthetic_disposable");
} finally { await pool.end(); }
const base = "http://127.0.0.1:8080";
const admin = process.env.OPENMASU_ADMIN_KEY!;
assert.equal(process.env.OPENMASU_PUBLIC_BASE_URL, "https://api.config.synthetic.example");
assert.equal(process.env.OPENMASU_REDIRECTOR_BASE_URL, "https://links.config.synthetic.example");
const appId = process.env.OPENMASU_MAX_APP_ID!;
for (const [destination, expected] of [
  ["https://destination.config.synthetic.example/path", 201],
  ["https://not-allowed.config.synthetic.example/path", 400],
] as const) {
  const result = await fetch(`${base}/v1/admin/tracking-links`, {
    method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, destination_kind: "custom_https", destination_url: destination }),
  });
  assert.equal(result.status, expected);
  if (expected === 400) assert.match(await result.text(), /destination_origin_not_allowed/);
}
const list = await fetch(`${base}/v1/admin/tracking-links?app_id=${appId}`, { headers: { authorization: `Bearer ${admin}` } });
assert.equal(list.status, 200);
const body = await list.json() as { data: Array<{ destination_url: string; measurement_url: string }> };
assert.ok(body.data.some(link => link.destination_url === "https://destination.config.synthetic.example/path"
  && link.measurement_url.startsWith("https://links.config.synthetic.example/r/")));
const login = await fetch(`${base}/dashboard/session`, { method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ admin_key: admin }) });
assert.equal(login.status, 303);
const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
assert.ok(cookie.startsWith("__Host-openmasu_dashboard="));
for (const [origin, expected] of [["https://old.config.synthetic.example", 403], ["https://api.config.synthetic.example", 303]] as const) {
  const result = await fetch(`${base}/dashboard/session/delete`, { method: "POST", redirect: "manual",
    headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf_token: csrfToken(cookie.slice(cookie.indexOf("=") + 1)) }) });
  assert.equal(result.status, expected);
}
console.log("Synthetic deployment configuration passed: allowed=201 denied=400 public_origin=bound.");
