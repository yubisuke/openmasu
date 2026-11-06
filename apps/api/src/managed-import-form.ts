import type { IncomingMessage } from "node:http";
import { ManagedImportError, managedImportLimits } from "@openmasu/runtime/managed-imports";
import { readRawBody } from "./raw-body.js";

export function managedImportScalar(form: FormData | URLSearchParams, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || form.getAll(name).length !== 1) throw new ManagedImportError("import_form_invalid");
  return value;
}
export function managedImportFields(form: FormData | URLSearchParams, allowed: readonly string[]) {
  if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) throw new ManagedImportError("import_form_invalid");
}
export async function readManagedImportForm(request: IncomingMessage): Promise<FormData> {
  const type = request.headers["content-type"];
  if (typeof type !== "string" || !/^multipart\/form-data;\s*boundary=(?:"[A-Za-z0-9'()+_,./:=? -]{1,70}"|[A-Za-z0-9'()+_,./:=?-]{1,70})$/i.test(type)) {
    throw new ManagedImportError("import_multipart_required",415);
  }
  const limit = managedImportLimits.maxBytes + 16 * 1024, length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length)>limit)) throw new ManagedImportError("import_upload_size",413);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([readRawBody(request,limit),new Promise<never>((_,reject) => {
      timer=setTimeout(() => { reject(new ManagedImportError("import_upload_timeout",408)); request.destroy(); },30_000);
    })]);
    new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    return await new Request("http://openmasu.local/import",{method:"POST",headers:{"content-type":type},body:new Uint8Array(bytes)}).formData();
  } catch (error) {
    if (error instanceof ManagedImportError || (error as Error).message === "request_too_large") throw error;
    throw new ManagedImportError("import_form_invalid");
  } finally { if(timer) clearTimeout(timer); }
}
