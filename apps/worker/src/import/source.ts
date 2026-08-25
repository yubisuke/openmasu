import { readFileSync, statSync } from "node:fs";
import type { ImportMapping } from "./mapping.js";

type Any = Record<string, any>;

export type ImportLimits = {
  maxBytes: number;
  maxRows: number;
  maxRowBytes: number;
};

export class ImportLimitError extends Error {}

function csvCells(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function parseCsv(source: string): Any[] {
  const [header, ...rows] = csvCells(source);
  if (!header?.length) return [];
  const names = header.map((name) => name.trim());
  if (new Set(names).size !== names.length) throw new Error("CSV header names must be unique");
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

export function readRows(path: string, mapping: ImportMapping, limits: ImportLimits): { bytes: number; rows: Any[] } {
  const bytes = statSync(path).size;
  if (bytes > limits.maxBytes) throw new ImportLimitError(`import file exceeds ${limits.maxBytes} bytes`);
  const source = readFileSync(path, "utf8");
  const rows = mapping.format === "csv" ? parseCsv(source) : mapping.format === "jsonl" ? parseJsonLines(source) : parseJson(source);
  if (rows.length > limits.maxRows) throw new ImportLimitError(`import file exceeds ${limits.maxRows} rows`);
  for (const [index, row] of rows.entries()) {
    if (Buffer.byteLength(JSON.stringify(row), "utf8") > limits.maxRowBytes) {
      throw new ImportLimitError(`import row ${index} exceeds ${limits.maxRowBytes} bytes`);
    }
  }
  return { bytes, rows };
}
