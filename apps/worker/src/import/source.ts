import { readFileSync, statSync } from "node:fs";
import type { ImportMapping } from "./mapping.js";

type Any = Record<string, any>;

export type ImportLimits = {
  maxBytes: number;
  maxRows: number;
  maxRowBytes: number;
};

export class ImportLimitError extends Error {}

export class CsvFormatError extends Error {
  constructor(readonly code: "csv_quotes_invalid" | "csv_header_invalid" | "csv_width_invalid", readonly rowNumber: number) {
    super(code);
  }
}

function csvCells(source: string, strict = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  let fieldPresent = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      fieldPresent = true;
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        if (strict && !quoted && (cell.length > 0 || closed)) throw new CsvFormatError("csv_quotes_invalid", rows.length + 1);
        if (quoted) closed = true;
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fieldPresent = true;
      row.push(cell);
      cell = "";
      closed = false;
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0) || (strict && fieldPresent)) rows.push(row);
      row = [];
      cell = "";
      closed = false;
      fieldPresent = false;
    } else {
      if (strict && closed && !quoted) throw new CsvFormatError("csv_quotes_invalid", rows.length + 1);
      cell += character;
      fieldPresent = true;
    }
  }
  if (quoted) {
    if (strict) throw new CsvFormatError("csv_quotes_invalid", rows.length + 1);
    throw new Error("CSV contains an unterminated quoted field");
  }
  row.push(cell);
  if (row.some((value) => value.length > 0) || (strict && fieldPresent)) rows.push(row);
  return rows;
}

export function parseCsv(source: string, strict = false): Any[] {
  const [header, ...rows] = csvCells(source, strict);
  if (!header?.length) return [];
  const names = header.map((name) => name.trim());
  if (new Set(names).size !== names.length || (strict && names.some(name => !name))) {
    if (strict) throw new CsvFormatError("csv_header_invalid", 1);
    throw new Error("CSV header names must be unique");
  }
  if (strict) for (const [index, values] of rows.entries()) {
    if (values.length !== names.length) throw new CsvFormatError("csv_width_invalid", index + 2);
  }
  return rows.map((values) => Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""])));
}

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
