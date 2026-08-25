import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PayloadStore {
  write(scope: { tenantId: string; appId: string; objectId: string }, plaintext: Buffer): Promise<string>;
  read(reference: string): Promise<Buffer>;
  purge(reference: string): Promise<void>;
  scanFor(value: string): Promise<boolean>;
}

type EncryptedObject = {
  version: 1;
  key_id: string;
  tenant_id: string;
  app_id: string;
  nonce: string;
  tag: string;
  ciphertext: string;
};
type WrappedKey = { version: 1; nonce: string; tag: string; ciphertext: string };

function referenceKeyId(reference: string): string {
  if (!reference.startsWith("encrypted:")) throw new Error("unsupported payload reference");
  const keyId = reference.slice("encrypted:".length);
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(keyId) || keyId.includes("..")) {
    throw new Error("invalid payload reference");
  }
  return keyId;
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(key: Buffer, value: { nonce: string; tag: string; ciphertext: string }, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]);
}

/** AES-256-GCM envelope store with a random data-encryption key per object. */
export class EncryptedFilePayloadStore implements PayloadStore {
  private readonly objectRoot: string;
  private readonly keyRoot: string;
  private readonly wrappingKey: Buffer;

  constructor(private readonly root: string, masterSecret: string) {
    if (Buffer.byteLength(masterSecret, "utf8") < 32) throw new Error("payload master key must contain at least 32 bytes");
    this.objectRoot = join(root, "objects");
    this.keyRoot = join(root, "keys");
    this.wrappingKey = createHash("sha256").update(masterSecret).digest();
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.keyRoot, { recursive: true, mode: 0o700 });
  }

  async write(scope: { tenantId: string; appId: string; objectId: string }, plaintext: Buffer): Promise<string> {
    const safe = `${scope.tenantId}-${scope.appId}-${scope.objectId}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const keyId = `${safe}.${randomBytes(8).toString("hex")}`;
    const dataKey = randomBytes(32);
    const aad = Buffer.from(`${scope.tenantId}\u0000${scope.appId}\u0000${keyId}`, "utf8");
    const payload = encrypt(dataKey, plaintext, aad);
    const wrapped = encrypt(this.wrappingKey, dataKey, Buffer.from(keyId, "utf8"));
    const object: EncryptedObject = {
      version: 1, key_id: keyId, tenant_id: scope.tenantId, app_id: scope.appId,
      nonce: payload.nonce.toString("base64url"), tag: payload.tag.toString("base64url"),
      ciphertext: payload.ciphertext.toString("base64url"),
    };
    const keyEntry: WrappedKey = {
      version: 1, nonce: wrapped.nonce.toString("base64url"), tag: wrapped.tag.toString("base64url"),
      ciphertext: wrapped.ciphertext.toString("base64url"),
    };
    writeFileSync(resolve(this.keyRoot, `${keyId}.json`), JSON.stringify(keyEntry), { flag: "wx", mode: 0o600 });
    try {
      writeFileSync(resolve(this.objectRoot, `${keyId}.json`), JSON.stringify(object), { flag: "wx", mode: 0o600 });
    } catch (error) {
      rmSync(resolve(this.keyRoot, `${keyId}.json`), { force: true });
      throw error;
    }
    return `encrypted:${keyId}`;
  }

  async read(reference: string): Promise<Buffer> {
    const keyId = referenceKeyId(reference);
    const object = JSON.parse(readFileSync(join(this.objectRoot, `${keyId}.json`), "utf8")) as EncryptedObject;
    const wrapped = JSON.parse(readFileSync(join(this.keyRoot, `${keyId}.json`), "utf8")) as WrappedKey;
    const dataKey = decrypt(this.wrappingKey, wrapped, Buffer.from(keyId, "utf8"));
    const aad = Buffer.from(`${object.tenant_id}\u0000${object.app_id}\u0000${keyId}`, "utf8");
    return decrypt(dataKey, object, aad);
  }

  async purge(reference: string): Promise<void> {
    const keyId = referenceKeyId(reference);
    rmSync(join(this.objectRoot, `${keyId}.json`), { force: true });
    rmSync(join(this.keyRoot, `${keyId}.json`), { force: true });
  }

  async scanFor(value: string): Promise<boolean> {
    if (!value) return false;
    for (const directory of [this.objectRoot, this.keyRoot]) {
      for (const name of readdirSync(directory)) {
        if (readFileSync(join(directory, name)).includes(Buffer.from(value, "utf8"))) return true;
      }
    }
    return false;
  }
}
