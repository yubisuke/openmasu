import type { IncomingMessage } from "node:http";

export class RequestBodyError extends Error {
  constructor(message: "request_too_large" | "body_read_failed", readonly statusCode: number) {
    super(message);
  }
}

export async function readRawBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) throw new RequestBodyError("request_too_large", 413);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("body_read_failed", 400);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody<T>(body: Buffer): T {
  return JSON.parse(body.toString("utf8")) as T;
}
