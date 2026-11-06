import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export interface PayloadStore {
  write(scope: { tenantId: string; appId: string; objectId: string }, plaintext: Buffer): Promise<string>;
  /** Throws PayloadNotFoundError only when the object or its wrapped key is absent. */
  read(reference: string): Promise<Buffer>;
  purge(reference: string): Promise<void>;
  scanFor(value: string): Promise<boolean>;
}

/** A payload reference is no longer backed by either an object or its wrapped key. */
export class PayloadNotFoundError extends Error {
  constructor(readonly reference: string, options?: ErrorOptions) {
    super("payload_not_found", options);
    this.name = "PayloadNotFoundError";
  }
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
type WrappedKey = { version: 1 | 2; wrapping_key_id?: string; nonce: string; tag: string; ciphertext: string };

export const PAYLOAD_KEY_STATE_FILE = "wrapping-key-state.json";
type ReadyKeyState = { version: 1; phase: "ready"; key_id: string; key_check: string; verified_key_checks: number };
type PendingKeyState = {
  version: 1; phase: "rewrapping" | "verifying"; from_key_id: string; from_check: string;
  to_key_id: string; to_check: string; after: string | null; verified_key_checks: number;
};
type KeyState = ReadyKeyState | PendingKeyState;
const keyRef = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const checkValue = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keyCheck = (key: Buffer, id: string): string => createHmac("sha256", key).update(`openmasu:payload-wrapping-key:${id}`).digest("hex");
const lockName = ".payload-operation.lock";
const reclaimName = ".payload-lock-reclaim";
const temporaryNames = [".payload-key-entry.tmp", ".payload-key-state.tmp"] as const;
type LockOwner = { host: string; pid: number; started: string | null };

function processStart(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19] ?? null; }
  catch { return null; }
}

function endedOwner(owner: LockOwner): boolean {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || (owner.started !== null && (typeof owner.started !== "string" || !/^\d+$/.test(owner.started)))) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  const started = processStart(owner.pid);
  return owner.started !== null && started !== null && owner.started !== started;
}

function removeLease(path: string): void {
  // Never recursively remove a directory that could contain unexpected files.
  const owner = join(path, "owner.json");
  if (existsSync(owner)) {
    if (!lstatSync(owner).isFile()) throw new Error("payload_lock_owner_invalid");
    rmSync(owner);
  }
  rmdirSync(path);
}

function reclaimEndedOwner(root: string): void {
  const guard = join(root, reclaimName), lock = join(root, lockName);
  try { mkdirSync(guard, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  try {
    let owner: LockOwner;
    try { owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as LockOwner; }
    catch { return; } // Uncertain ownership requires offline operator recovery.
    if (!endedOwner(owner)) return;
    // A dead process may have been killed after a flushed staging file, before rename.
    // Keep its published lease in place until cleanup is complete: a new owner
    // must not acquire the lease and create a staging file that we then remove.
    for (const name of temporaryNames) {
      const path = join(root, name);
      if (existsSync(path)) {
        if (!lstatSync(path).isFile()) throw new Error("payload_staging_invalid");
        rmSync(path);
      }
    }
    const discarded = join(guard, "ended-lease");
    renameSync(lock, discarded);
    removeLease(discarded);
  } finally { rmdirSync(guard); }
}

function readKeyState(root: string): KeyState | undefined {
  const path = join(root, PAYLOAD_KEY_STATE_FILE);
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile()) throw new Error("payload_key_state_invalid");
  const state = JSON.parse(readFileSync(path, "utf8")) as KeyState;
  if (state?.version !== 1 || !Number.isSafeInteger(state.verified_key_checks) || state.verified_key_checks < 0) throw new Error("payload_key_state_invalid");
  if (state.phase === "ready") {
    if (!keyRef(state.key_id) || !checkValue(state.key_check)) throw new Error("payload_key_state_invalid");
  } else if (state.phase === "rewrapping" || state.phase === "verifying") {
    if (!keyRef(state.from_key_id) || !keyRef(state.to_key_id) || state.from_key_id === state.to_key_id
      || !checkValue(state.from_check) || !checkValue(state.to_check)
      || (state.after !== null && (typeof state.after !== "string" || !/^[A-Za-z0-9._-]+\.json$/.test(state.after) || state.after.includes("..")))) throw new Error("payload_key_state_invalid");
  } else throw new Error("payload_key_state_invalid");
  return state;
}

/** Backup custody includes this non-secret state; pending rotations cannot be backed up. */
export function readyPayloadKeyState(root: string): Buffer | undefined {
  const state = readKeyState(root);
  if (!state) return undefined;
  if (state.phase !== "ready") throw new Error("payload_rewrap_in_progress");
  return readFileSync(join(root, PAYLOAD_KEY_STATE_FILE));
}

async function withPayloadLock<T>(root: string, work: () => T | Promise<T>): Promise<T> {
  const path = join(root, lockName), deadline = Date.now() + 5_000;
  // Publish a nonempty owner directory atomically. A crash cannot leave an
  // ownerless acquisition, and rename cannot replace another nonempty lease.
  const holder = mkdtempSync(join(root, ".payload-lease-"));
  writeFileSync(join(holder, "owner.json"), JSON.stringify({ host: hostname(), pid: process.pid, started: processStart(process.pid) } satisfies LockOwner), { flag: "wx", mode: 0o600 });
  let acquired = false;
  try {
    while (true) {
      try { renameSync(holder, path); acquired = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        reclaimEndedOwner(root);
        if (Date.now() >= deadline) throw new Error("payload_store_busy");
        await delay(10);
      }
    }
    return await work();
  } finally {
    if (acquired) renameSync(path, holder);
    removeLease(holder);
  }
}

/** Offline recovery only, after stopping every client including the prior rewrap command. */
export function recoverOfflinePayloadLock(root: string, writersStopped: boolean): void {
  if (!writersStopped) throw new Error("payload_writers_stopped_ack_required");
  if (!lstatSync(root).isDirectory()) throw new Error("payload_store_root_invalid");
  const path = join(root, lockName);
  if (existsSync(path)) removeLease(path);
  const guard = join(root, reclaimName);
  if (existsSync(guard)) {
    const ended = join(guard, "ended-lease");
    if (existsSync(ended)) removeLease(ended);
    rmdirSync(guard);
  }
  for (const name of temporaryNames) {
    const file = join(root, name);
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) throw new Error("payload_staging_invalid");
      rmSync(file);
    }
  }
}

function replaceAtomically(root: string, destination: string, value: unknown, temporary: typeof temporaryNames[number]): void {
  const path = join(root, temporary);
  const fd = openSync(path, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(path, destination);
  } finally { rmSync(path, { force: true }); }
}

function wrappedAad(keyId: string, wrapped: Pick<WrappedKey, "version" | "wrapping_key_id">): Buffer {
  if (wrapped.version === 1 && wrapped.wrapping_key_id === undefined) return Buffer.from(keyId, "utf8");
  if (wrapped.version !== 2 || !keyRef(wrapped.wrapping_key_id)) throw new Error("payload_wrapped_key_invalid");
  return Buffer.from(`openmasu:wrapped-key:v2\u0000${keyId}\u0000${wrapped.wrapping_key_id}`, "utf8");
}

/** Bounded memory, deterministic keyset order. Writers remain stopped between batches. */
function keyPage(directory: string, after: string | null, limit: number): string[] {
  const page: string[] = [], dir = opendirSync(directory);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name) || entry.name.includes("..")) throw new Error("payload_wrapped_key_invalid");
      if (after !== null && entry.name <= after) continue;
      let low = 0, high = page.length;
      while (low < high) { const middle = (low + high) >>> 1; if (page[middle] < entry.name) low = middle + 1; else high = middle; }
      if (low <= limit) { page.splice(low, 0, entry.name); if (page.length > limit + 1) page.pop(); }
    }
  } finally { dir.closeSync(); }
  return page;
}

export interface PayloadRewrapResult {
  phase: "rewrapping" | "verifying" | "ready";
  processed: number;
  verified_key_checks: number;
  cutover_ready: boolean;
  old_backup_key_custody_required: true;
}

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

  private currentKey(): ReadyKeyState | undefined {
    const state = readKeyState(this.root);
    if (!state) return undefined;
    if (state.phase !== "ready") throw new Error("payload_rewrap_in_progress");
    if (keyCheck(this.wrappingKey, state.key_id) !== state.key_check) throw new Error("payload_wrapping_key_mismatch");
    return state;
  }

  private unwrap(keyId: string, wrapped: WrappedKey, key = this.wrappingKey): Buffer {
    const value = decrypt(key, wrapped, wrappedAad(keyId, wrapped));
    if (value.length !== 32) throw new Error("payload_wrapped_key_invalid");
    return value;
  }

  async write(scope: { tenantId: string; appId: string; objectId: string }, plaintext: Buffer): Promise<string> {
    return withPayloadLock(this.root, () => {
      const current = this.currentKey();
      const safe = `${scope.tenantId}-${scope.appId}-${scope.objectId}`.replace(/[^A-Za-z0-9._-]/g, "_");
      const keyId = `${safe}.${randomBytes(8).toString("hex")}`;
      const dataKey = randomBytes(32);
      const aad = Buffer.from(`${scope.tenantId}\u0000${scope.appId}\u0000${keyId}`, "utf8");
      const payload = encrypt(dataKey, plaintext, aad);
      const identity = current ? { version: 2 as const, wrapping_key_id: current.key_id } : { version: 1 as const };
      const wrapped = encrypt(this.wrappingKey, dataKey, wrappedAad(keyId, identity));
      const object: EncryptedObject = {
        version: 1, key_id: keyId, tenant_id: scope.tenantId, app_id: scope.appId,
        nonce: payload.nonce.toString("base64url"), tag: payload.tag.toString("base64url"),
        ciphertext: payload.ciphertext.toString("base64url"),
      };
      const keyEntry: WrappedKey = {
        ...identity, nonce: wrapped.nonce.toString("base64url"), tag: wrapped.tag.toString("base64url"),
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
    });
  }

  async read(reference: string): Promise<Buffer> {
    const keyId = referenceKeyId(reference);
    const current = this.currentKey();
    let object: EncryptedObject;
    let wrapped: WrappedKey;
    try {
      object = JSON.parse(readFileSync(join(this.objectRoot, `${keyId}.json`), "utf8")) as EncryptedObject;
      wrapped = JSON.parse(readFileSync(join(this.keyRoot, `${keyId}.json`), "utf8")) as WrappedKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PayloadNotFoundError(reference, { cause: error });
      }
      throw error;
    }
    if (current ? wrapped.version !== 2 || wrapped.wrapping_key_id !== current.key_id : wrapped.version !== 1) throw new Error("payload_wrapping_key_mismatch");
    const dataKey = this.unwrap(keyId, wrapped);
    const aad = Buffer.from(`${object.tenant_id}\u0000${object.app_id}\u0000${keyId}`, "utf8");
    return decrypt(dataKey, object, aad);
  }

  /** Verify an operator's out-of-band master key without decrypting stored payloads. */
  async verifyWrappedKeys(): Promise<void> {
    const current = this.currentKey();
    for (const name of readdirSync(this.keyRoot)) {
      if (!name.endsWith(".json")) throw new Error("payload_wrapped_key_invalid");
      const wrapped = JSON.parse(readFileSync(join(this.keyRoot, name), "utf8")) as WrappedKey;
      if (current ? wrapped.version !== 2 || wrapped.wrapping_key_id !== current.key_id : wrapped.version !== 1) throw new Error("payload_wrapping_key_mismatch");
      this.unwrap(name.slice(0, -5), wrapped);
    }
  }

  async purge(reference: string): Promise<void> {
    const keyId = referenceKeyId(reference);
    await withPayloadLock(this.root, () => {
      rmSync(join(this.objectRoot, `${keyId}.json`), { force: true });
      rmSync(join(this.keyRoot, `${keyId}.json`), { force: true });
    });
  }

  /** Offline only. The root lease serializes key replacement with write/purge across processes. */
  async rewrapBatch(input: { fromKeyRef: string; toKeyRef: string; targetSecret: string; limit: number; writersStopped: boolean }): Promise<PayloadRewrapResult> {
    if (!input.writersStopped) throw new Error("payload_writers_stopped_ack_required");
    if (!keyRef(input.fromKeyRef) || !keyRef(input.toKeyRef) || input.fromKeyRef === input.toKeyRef
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000 || Buffer.byteLength(input.targetSecret) < 32) throw new Error("payload_rewrap_arguments_invalid");
    const target = createHash("sha256").update(input.targetSecret).digest();
    if (target.equals(this.wrappingKey)) throw new Error("payload_rewrap_distinct_key_required");
    return withPayloadLock(this.root, () => {
      let state = readKeyState(this.root);
      const fromCheck = keyCheck(this.wrappingKey, input.fromKeyRef), toCheck = keyCheck(target, input.toKeyRef);
      const result = (value: KeyState, processed: number): PayloadRewrapResult => ({ phase: value.phase, processed,
        verified_key_checks: value.verified_key_checks, cutover_ready: value.phase === "ready", old_backup_key_custody_required: true });
      const save = (value: KeyState) => replaceAtomically(this.root, join(this.root, PAYLOAD_KEY_STATE_FILE), value, ".payload-key-state.tmp");
      if (state?.phase === "ready" && state.key_id === input.toKeyRef) {
        if (state.key_check !== toCheck) throw new Error("payload_wrapping_key_mismatch");
        return result(state, 0);
      }
      if (!state || state.phase === "ready") {
        if (state && (state.key_id !== input.fromKeyRef || state.key_check !== fromCheck)) throw new Error("payload_wrapping_key_mismatch");
        // Verify possession before blocking a legacy store, even when its first key is absent.
        if (!state) {
          const first = keyPage(this.keyRoot, null, 1)[0];
          if (first) {
            const wrapped = JSON.parse(readFileSync(join(this.keyRoot, first), "utf8")) as WrappedKey;
            if (wrapped.version !== 1) throw new Error("payload_key_state_invalid");
            this.unwrap(first.slice(0, -5), wrapped);
          }
        }
        state = { version: 1, phase: "rewrapping", from_key_id: input.fromKeyRef, from_check: fromCheck,
          to_key_id: input.toKeyRef, to_check: toCheck, after: null, verified_key_checks: 0 };
        save(state);
      }
      if (state.from_key_id !== input.fromKeyRef || state.to_key_id !== input.toKeyRef || state.from_check !== fromCheck || state.to_check !== toCheck) throw new Error("payload_rewrap_identity_mismatch");
      const page = keyPage(this.keyRoot, state.after, input.limit), selected = page.slice(0, input.limit);
      for (const name of selected) {
        const path = join(this.keyRoot, name), keyId = name.slice(0, -5);
        // A missing object is an incomplete prior operation, not permission to reconstruct it.
        if (!lstatSync(join(this.objectRoot, name)).isFile()) throw new Error("payload_object_invalid");
        const wrapped = JSON.parse(readFileSync(path, "utf8")) as WrappedKey;
        if (wrapped.version === 2 && wrapped.wrapping_key_id === state.to_key_id) {
          this.unwrap(keyId, wrapped, target); // Also handles replacement-before-checkpoint interruption.
        } else {
          if (state.phase === "verifying" || (wrapped.version === 2 && wrapped.wrapping_key_id !== state.from_key_id)) throw new Error("payload_rewrap_verification_failed");
          const dataKey = this.unwrap(keyId, wrapped), identity = { version: 2 as const, wrapping_key_id: state.to_key_id };
          const encrypted = encrypt(target, dataKey, wrappedAad(keyId, identity));
          const replacement: WrappedKey = { ...identity, nonce: encrypted.nonce.toString("base64url"), tag: encrypted.tag.toString("base64url"), ciphertext: encrypted.ciphertext.toString("base64url") };
          this.unwrap(keyId, replacement, target);
          replaceAtomically(this.root, path, replacement, ".payload-key-entry.tmp");
        }
      }
      if (state.phase === "verifying") state.verified_key_checks += selected.length;
      if (page.length <= input.limit) {
        if (state.phase === "rewrapping") { state.phase = "verifying"; state.after = null; }
        else {
          const ready: ReadyKeyState = { version: 1, phase: "ready", key_id: state.to_key_id, key_check: state.to_check, verified_key_checks: state.verified_key_checks };
          save(ready);
          return result(ready, selected.length);
        }
      } else state.after = selected.at(-1)!;
      save(state);
      return result(state, selected.length);
    });
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
