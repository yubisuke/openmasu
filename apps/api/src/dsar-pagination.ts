import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { uuidV7 } from "@openmasu/runtime";
import { acquirePrivacyTenantXactFence } from "@openmasu/runtime/privacy-fence";
import { comparisonPrivacyEpoch } from "@openmasu/runtime/fixed-comparison";

export const dsarLimits = { rows: 500, defaultRows: 200, bytes: 256 * 1024, cursorBytes: 16384, ttlMs: 3600_000 } as const;
export class DsarError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export type DsarScope = { tenantId: string; appId: string; installationId: string; requestType: string;
  installationKeyId: string; sdkKeyId: string; installationDigest: string; cursorSecret: string };
export type DsarPageState = { version: 1; scope: string; requestId: string; cutoff: string; expires: number;
  epoch: string; database: string; snapshot: string; privacy: string; stage: number; after: [string,string] | null };
const key = (secret: string) => createHash("sha256").update(`openmasu-dsar-cursor-v1\0${secret}`).digest();
const scopeDigest = (scope: DsarScope) => createHmac("sha256", key(scope.cursorSecret)).update(JSON.stringify([
  scope.tenantId,scope.appId,scope.installationId,scope.requestType,scope.installationKeyId,scope.sdkKeyId,scope.installationDigest,
])).digest("hex");
const aad = Buffer.from("openmasu-dsar-cursor-v1");
export function encodeDsarCursor(state: DsarPageState, secret: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm",key(secret),nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(JSON.stringify(state),"utf8"),cipher.final()]);
  const result = Buffer.concat([nonce,cipher.getAuthTag(),body]).toString("base64url");
  if (result.length > dsarLimits.cursorBytes) throw new DsarError("dsar_snapshot_too_large",503);
  return result;
}
export function decodeDsarCursor(cursor: string, scope: DsarScope, now: Date): DsarPageState {
  let state: DsarPageState;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > dsarLimits.cursorBytes) throw Error();
    const bytes = Buffer.from(cursor,"base64url");
    const decipher = createDecipheriv("aes-256-gcm",key(scope.cursorSecret),bytes.subarray(0,12));
    decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12,28));
    state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8"));
    if (state.version !== 1 || state.scope !== scopeDigest(scope) || !Number.isInteger(state.stage)
      || state.stage < 0 || state.stage > 2 || !Number.isFinite(state.expires)
      || (state.after !== null && (!Array.isArray(state.after) || state.after.length !== 2
        || state.after.some(value=>typeof value !== "string")))) throw Error();
  } catch { throw new DsarError("dsar_cursor_invalid"); }
  if (now.valueOf() >= state.expires || now.valueOf() < Date.parse(state.cutoff)) throw new DsarError("dsar_cursor_expired",410);
  return state;
}
/** Each page reauthorizes inside the deletion fence; a cursor is not a credential. */
export async function prepareDsarPage(client: PoolClient, scope: DsarScope, cursor: string | undefined, now: Date): Promise<DsarPageState> {
  await client.query("SET LOCAL statement_timeout='10s'");
  await acquirePrivacyTenantXactFence(client,scope.tenantId,"shared");
  const active = await client.query(`SELECT 1 FROM control.installation_credentials_current credential
    JOIN control.sdk_keys_current sdk USING(tenant_id,app_id,sdk_key_id)
    WHERE credential.tenant_id=$1 AND credential.app_id=$2 AND credential.installation_key_id=$3
      AND credential.sdk_key_id=$4 AND credential.installation_id_digest=$5
      AND credential.status='active' AND sdk.status='active'`,
    [scope.tenantId,scope.appId,scope.installationKeyId,scope.sdkKeyId,scope.installationDigest]);
  if (!active.rowCount) throw new DsarError("dsar_credential_inactive",401);
  const current = (await client.query<{epoch:string;database:string;snapshot:string}>(`SELECT
    pg_postmaster_start_time()::text AS epoch, current_database()||':'||(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database,
    pg_current_snapshot()::text AS snapshot`)).rows[0];
  const privacy = await comparisonPrivacyEpoch(client,scope.tenantId);
  if (cursor) {
    const state = decodeDsarCursor(cursor,scope,now);
    if (state.epoch !== current.epoch || state.database !== current.database) throw new DsarError("dsar_snapshot_unavailable",410);
    if (state.privacy !== privacy) throw new DsarError("dsar_privacy_changed",409);
    return state;
  }
  // Bound the active transaction list before returning a continuation token.
  if (current.snapshot.length > 8192) throw new DsarError("dsar_snapshot_too_large",503);
  return { version:1,scope:scopeDigest(scope),requestId:`dsar:${uuidV7(now.valueOf())}`,cutoff:now.toISOString(),
    expires:now.valueOf()+dsarLimits.ttlMs,...current,privacy,stage:0,after:null };
}
