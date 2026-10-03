import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { AdminIdentity, AppAdminIdentity } from "../admin-auth.js";
import type { RouteDefinition } from "../routes.js";
import type { DashboardSession } from "../session.js";
import type { RequestDecoder } from "../http-responses.js";

/** The dispatcher selects this pool from the declaration's mutates flag. */
export type HttpRequestContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly target: URL;
  readonly route: RouteDefinition;
  readonly pool: Pool;
  readonly startedAt: number;
  readonly decoder: RequestDecoder;
};

export type AdminRequestContext = HttpRequestContext & { readonly identity: AdminIdentity };
export type DashboardTenantContext = HttpRequestContext & {
  readonly session: DashboardSession;
  readonly sessionIdentity: AdminIdentity;
};
export type DashboardAppContext = DashboardTenantContext & {
  readonly appId: string;
  readonly appIdentity: AppAdminIdentity;
};

/** SDK/provider authentication remains inside its existing raw-body receiver. */
export type RegisteredController =
  | { readonly boundary: "receiver" | "session"; readonly handle: (context: HttpRequestContext) => Promise<void> }
  | { readonly boundary: "admin"; readonly handle: (context: AdminRequestContext) => Promise<void> }
  | { readonly boundary: "dashboard_tenant"; readonly handle: (context: DashboardTenantContext) => Promise<void> }
  | { readonly boundary: "dashboard_app"; readonly handle: (context: DashboardAppContext) => Promise<void> };
