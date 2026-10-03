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

export function parseCsv(source: string, strict = false): Record<string, string>[] {
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

export function decimalToUnscaled(value: string, scale = 6): string {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value.trim());
  if (!match) throw new Error("cost amount must be a non-negative decimal without exponent notation");
  const fraction = match[2] ?? "";
  if (fraction.length > scale) throw new Error(`cost amount exceeds scale ${scale}`);
  return `${match[1]}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=[0-9])/, "");
}
