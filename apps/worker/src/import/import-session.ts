import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { ImportMapping } from "./mapping.js";
import { parseMapping } from "./mapping.js";
import {
  analyzeMmpImportSource,
  runMmpImportSourceCommand,
  type ImportPreviewSummary,
  type ImportSummary,
} from "./runner.js";
import type { ImportLimits } from "./source.js";

export type ImportSessionScope = {
  tenant_id: string;
  app_id: string;
  source_id: string;
};

export type ImportSessionPreview = {
  format: "openmasu-import-session-v1";
  mode: "preview";
  persistence: "none";
  scope: ImportSessionScope;
  mapping_digest: string;
  source_digest: string;
  confirmation_token: string;
  preview: ImportPreviewSummary;
};

export type ImportSessionCommitted = {
  format: "openmasu-import-session-v1";
  mode: "committed";
  persistence: "postgresql_ledger";
  scope: ImportSessionScope;
  mapping_digest: string;
  source_digest: string;
  summary: ImportSummary;
  links?: {
    dashboard: string;
    differences: string;
    aggregate_csv: string;
  };
};

export type PreparedImportSession = {
  output: ImportSessionPreview;
  mappingBytes: Uint8Array;
  sourceBytes: Uint8Array;
  sourceLabel: string;
  siblingMappings: readonly ImportMapping[];
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function confirmationToken(mappingBytes: Uint8Array, sourceBytes: Uint8Array): string {
  return createHash("sha256")
    .update("openmasu-import-session-v1\0")
    .update(String(mappingBytes.byteLength))
    .update("\0")
    .update(mappingBytes)
    .update(String(sourceBytes.byteLength))
    .update("\0")
    .update(sourceBytes)
    .digest("hex");
}

function sessionLinks(baseUrl: string | undefined, appId: string): ImportSessionCommitted["links"] {
  if (!baseUrl) return undefined;
  const parsed = new URL(baseUrl);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("OPENMASU_PUBLIC_BASE_URL must be an HTTP(S) URL without embedded credentials");
  }
  const root = parsed.origin;
  const app = encodeURIComponent(appId);
  return {
    dashboard: `${root}/dashboard/apps/${app}`,
    differences: `${root}/dashboard/apps/${app}/differences`,
    aggregate_csv: `${root}/dashboard/apps/${app}/cohorts.csv?export=true`,
  };
}

export function prepareImportSession(options: {
  mappingBytes: Uint8Array;
  sourceBytes: Uint8Array;
  sourceLabel?: string;
  siblingMappings?: readonly ImportMapping[];
  limits?: ImportLimits;
}): PreparedImportSession {
  const mappingBytes = Uint8Array.from(options.mappingBytes);
  const sourceBytes = Uint8Array.from(options.sourceBytes);
  const mapping = parseMapping(JSON.parse(Buffer.from(mappingBytes).toString("utf8")) as unknown);
  if (mapping.kind !== "mmp_raw") throw new Error("import sessions require an mmp_raw mapping");
  const siblingMappings = options.siblingMappings ?? [mapping];
  const analysis = analyzeMmpImportSource({
    mapping,
    sourceBytes,
    sourceLabel: options.sourceLabel,
    siblingMappings,
    limits: options.limits,
  });
  return {
    mappingBytes,
    sourceBytes,
    sourceLabel: options.sourceLabel ?? "import-source",
    siblingMappings,
    output: {
      format: "openmasu-import-session-v1",
      mode: "preview",
      persistence: "none",
      scope: {
        tenant_id: mapping.tenant_id,
        app_id: mapping.app_id,
        source_id: mapping.source_id,
      },
      mapping_digest: digest(mappingBytes),
      source_digest: digest(sourceBytes),
      confirmation_token: confirmationToken(mappingBytes, sourceBytes),
      preview: analysis.preview,
    },
  };
}

export function assertImportSessionConfirmation(prepared: PreparedImportSession, supplied: string): void {
  if (!/^[a-f0-9]{64}$/.test(supplied)) throw new Error("confirmation_token_invalid");
  const current = confirmationToken(prepared.mappingBytes, prepared.sourceBytes);
  if (current !== prepared.output.confirmation_token) throw new Error("confirmation_token_invalid");
  const expected = Buffer.from(current, "hex");
  const candidate = Buffer.from(supplied, "hex");
  if (!timingSafeEqual(expected, candidate)) throw new Error("confirmation_token_invalid");
}

export async function commitImportSession(options: {
  prepared: PreparedImportSession;
  confirmationToken: string;
  poolFactory: () => Pool;
  publicBaseUrl?: string;
  now?: Date;
}): Promise<ImportSessionCommitted> {
  assertImportSessionConfirmation(options.prepared, options.confirmationToken);
  const mapping = parseMapping(JSON.parse(Buffer.from(options.prepared.mappingBytes).toString("utf8")) as unknown);
  if (mapping.kind !== "mmp_raw") throw new Error("import sessions require an mmp_raw mapping");
  const links = sessionLinks(options.publicBaseUrl, mapping.app_id);
  const pool = options.poolFactory();
  try {
    const summary = await runMmpImportSourceCommand({
      pool,
      mapping,
      sourceBytes: options.prepared.sourceBytes,
      sourceLabel: options.prepared.sourceLabel,
      siblingMappings: options.prepared.siblingMappings,
      now: options.now,
    });
    return {
      format: "openmasu-import-session-v1",
      mode: "committed",
      persistence: "postgresql_ledger",
      scope: options.prepared.output.scope,
      mapping_digest: options.prepared.output.mapping_digest,
      source_digest: options.prepared.output.source_digest,
      summary,
      ...(links ? { links } : {}),
    };
  } finally {
    await pool.end();
  }
}

export async function executeImportSession(options: {
  prepared: PreparedImportSession;
  confirmationToken?: string;
  poolFactory: () => Pool;
  publicBaseUrl?: string;
  now?: Date;
}): Promise<ImportSessionPreview | ImportSessionCommitted> {
  if (!options.confirmationToken) return options.prepared.output;
  return commitImportSession({
    prepared: options.prepared,
    confirmationToken: options.confirmationToken,
    poolFactory: options.poolFactory,
    publicBaseUrl: options.publicBaseUrl,
    now: options.now,
  });
}
