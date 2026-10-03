import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { dashboardCss } from "./dashboard/css.js";

export const dashboardHeaders = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;

export const dashboardCssEtag = `"${createHash("sha256").update(dashboardCss).digest("hex")}"`;

export const decodedBodyMaximumBytes = 32 * 1024;
export type RequestDecoder = {
  readonly maximumBytes: number;
  readonly json: () => Promise<Record<string, unknown>>;
  readonly form: () => Promise<URLSearchParams>;
};

/** Created without consuming bytes; SDK/provider and multipart receivers keep their own readers. */
export function createRequestDecoder(request: IncomingMessage): RequestDecoder {
  return {
    maximumBytes: decodedBodyMaximumBytes,
    json: () => jsonBody(request),
    form: () => formBody(request),
  };
}

export async function rawBody(request: IncomingMessage, maximumBytes = decodedBodyMaximumBytes): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await rawBody(request)).toString("utf8")) as Record<string, unknown>;
}

export async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await rawBody(request)).toString("utf8"));
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

export function dashboardHtml(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...dashboardHeaders, "content-type": "text/html; charset=utf-8", ...headers });
  response.end(body);
}
