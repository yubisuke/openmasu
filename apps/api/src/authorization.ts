import type { AdminRole } from "./admin-auth.js";
import type { RouteCapability } from "./routes.js";

const roleCapabilities: Readonly<Record<AdminRole, ReadonlySet<RouteCapability>>> = {
  admin: new Set<RouteCapability>(["read", "operate", "administer"]),
  operator: new Set<RouteCapability>(["read", "operate"]),
  read_only: new Set<RouteCapability>(["read"]),
};

export function roleAllows(role: AdminRole, capability: RouteCapability | undefined): boolean {
  return capability === undefined || roleCapabilities[role].has(capability);
}

export function assertRoleAllows(role: AdminRole, capability: RouteCapability): void {
  if (!roleAllows(role, capability)) {
    const error = new Error("forbidden");
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}
