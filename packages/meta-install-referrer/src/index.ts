import { createDecipheriv } from "node:crypto";

export type MetaKey = { key_id: string; key_hex: string };
export type MetaDecryptResult =
  | { status: "absent" }
  | { status: "malformed" }
  | { status: "auth_failed"; attempted_key_ids: string[] }
  | { status: "decrypted"; key_id: string; context: Record<string, string | boolean>; is_ct?: 0 | 1; actual_timestamp?: number };

const allowedFields = new Set([
  "campaign_group_id", "campaign_id", "adgroup_id", "ad_id", "account_id",
  "ad_objective_name", "is_instagram", "publisher_platform", "platform_position",
]);

function keyBytes(key: MetaKey): Buffer | undefined {
  if (!/^[a-fA-F0-9]{64}$/.test(key.key_hex)) return undefined;
  return Buffer.from(key.key_hex, "hex");
}

function parsePlaintext(value: Buffer): { context: Record<string, string | boolean>; is_ct?: 0 | 1; actual_timestamp?: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const result: Record<string, string | boolean> = {};
  for (const [name, field] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowedFields.has(name)) continue;
    if (typeof field !== "string" && typeof field !== "boolean") return undefined;
    result[name] = field;
  }
  const source = parsed as Record<string, unknown>;
  const isCt = source.is_ct === 0 || source.is_ct === 1 ? source.is_ct : undefined;
  const actualTimestamp = Number.isSafeInteger(source.actual_timestamp) && Number(source.actual_timestamp) >= 0
    ? Number(source.actual_timestamp)
    : undefined;
  return Object.keys(result).length > 0
    ? { context: result, ...(isCt !== undefined ? { is_ct: isCt } : {}), ...(actualTimestamp !== undefined ? { actual_timestamp: actualTimestamp } : {}) }
    : undefined;
}

export function decryptMetaInstallReferrer(
  source: { data_hex?: string; nonce_hex?: string } | undefined,
  keys: readonly MetaKey[],
): MetaDecryptResult {
  if (!source || (!source.data_hex && !source.nonce_hex)) return { status: "absent" };
  if (!source.data_hex || !source.nonce_hex || !/^[a-fA-F0-9]+$/.test(source.data_hex)
    || !/^[a-fA-F0-9]{24}$/.test(source.nonce_hex) || source.data_hex.length < 34 || source.data_hex.length % 2 !== 0) {
    return { status: "malformed" };
  }
  const encrypted = Buffer.from(source.data_hex, "hex");
  const ciphertext = encrypted.subarray(0, -16);
  const tag = encrypted.subarray(-16);
  const attempted: string[] = [];
  for (const candidate of keys) {
    const key = keyBytes(candidate);
    if (!key) continue;
    attempted.push(candidate.key_id);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(source.nonce_hex, "hex"));
      decipher.setAAD(Buffer.alloc(0));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = parsePlaintext(plaintext);
      return parsed ? { status: "decrypted", key_id: candidate.key_id, ...parsed } : { status: "malformed" };
    } catch {
      // Authentication failure is intentionally indistinguishable from a wrong key.
    }
  }
  return attempted.length > 0 ? { status: "auth_failed", attempted_key_ids: attempted } : { status: "malformed" };
}
