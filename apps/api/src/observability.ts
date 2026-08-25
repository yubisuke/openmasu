import type { RouteHandler } from "./routes.js";

type HttpOperationalLogEvent = {
  readonly event: "http_request";
  readonly component: "api";
  readonly route: RouteHandler | "unmatched";
  readonly method: "GET" | "POST" | "OTHER";
  readonly status: number;
  readonly duration_ms: number;
  readonly error_code?: "internal_error";
  readonly payload?: never;
  readonly body?: never;
  readonly raw_body?: never;
  readonly authorization?: never;
  readonly cookie?: never;
  readonly query?: never;
  readonly installation_id?: never;
  readonly record_id?: never;
};

type ServiceOperationalLogEvent = {
  readonly event: "service_started";
  readonly component: "api";
  readonly payload?: never;
  readonly body?: never;
  readonly authorization?: never;
  readonly cookie?: never;
};

type OperationalLogEvent = HttpOperationalLogEvent | ServiceOperationalLogEvent;

export type OperationalLogWriter = (line: string) => void;

export function writeOperationalLog(event: OperationalLogEvent, writer: OperationalLogWriter): void {
  writer(`${JSON.stringify(event)}\n`);
}

export function boundedMethod(method: string | undefined): "GET" | "POST" | "OTHER" {
  return method === "GET" || method === "POST" ? method : "OTHER";
}
