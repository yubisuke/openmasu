import { readFileSync, statSync } from "node:fs";
import { parseCsv } from "@openmasu/runtime/import-normalization";
export { parseCsv, CsvFormatError } from "@openmasu/runtime/import-normalization";
import type { ImportMapping } from "./mapping.js";

type Any = Record<string, any>;

export type ImportLimits = {
  maxBytes: number;
  maxRows: number;
  maxRowBytes: number;
};

export class ImportLimitError extends Error {}



function parseJson(source: string): Any[] {
  const value: unknown = JSON.parse(source);
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    throw new Error("JSON import must contain an object or an array of objects");
  }
  return rows as Any[];
}

function parseJsonLines(source: string): Any[] {
  return source.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSONL rows must be objects");
    return value as Any;
  });
}

export function readRowsFromSource(
  sourceBytes: Uint8Array,
  mapping: ImportMapping,
  limits: ImportLimits,
): { bytes: number; rows: Any[] } {
  const bytes = sourceBytes.byteLength;
  if (bytes > limits.maxBytes) throw new ImportLimitError(`import file exceeds ${limits.maxBytes} bytes`);
  const source = Buffer.from(sourceBytes).toString("utf8");
  const rows = mapping.format === "csv" ? parseCsv(source) : mapping.format === "jsonl" ? parseJsonLines(source) : parseJson(source);
  if (rows.length > limits.maxRows) throw new ImportLimitError(`import file exceeds ${limits.maxRows} rows`);
  for (const [index, row] of rows.entries()) {
    if (Buffer.byteLength(JSON.stringify(row), "utf8") > limits.maxRowBytes) {
      throw new ImportLimitError(`import row ${index} exceeds ${limits.maxRowBytes} bytes`);
    }
  }
  return { bytes, rows };
}

export function readRows(path: string, mapping: ImportMapping, limits: ImportLimits): { bytes: number; rows: Any[] } {
  const bytes = statSync(path).size;
  if (bytes > limits.maxBytes) throw new ImportLimitError(`import file exceeds ${limits.maxBytes} bytes`);
  return readRowsFromSource(readFileSync(path), mapping, limits);
}
