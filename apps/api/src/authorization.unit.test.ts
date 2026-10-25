import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAdminRole } from "./admin-auth.js";
import { assertRoleAllows, roleAllows, routeAllows } from "./authorization.js";
import { parseAdminKeyCommand } from "./admin-key-cli.js";

describe("M5 minimum RBAC", () => {
  it("app_scope_requires_an_explicit_registered_target_and_cannot_grant_tenant_routes_or_extra_roles", () => {
    const scoped = { role: "admin" as const, appScope: "synthetic-app-a" };
    assert.equal(routeAllows(scoped, { capability: "administer" }), true);
    assert.equal(routeAllows(scoped, { capability: "read", tenantWideOnly: true }), false);
    assert.equal(routeAllows({ role: "admin" }, { capability: "administer", tenantWideOnly: true }), true);
    assert.equal(routeAllows({ role: "read_only", appScope: "synthetic-app-a" }, { capability: "operate" }), false);
    assert.deepEqual(parseAdminKeyCommand(["issue", "--tenant=synthetic-tenant", "--role=read_only", "--app=synthetic-app-a"]),
      { command: "issue", tenantId: "synthetic-tenant", role: "read_only", appScope: "synthetic-app-a" });
    assert.deepEqual(parseAdminKeyCommand(["issue", "--tenant=synthetic-tenant", "--role=admin"]),
      { command: "issue", tenantId: "synthetic-tenant", role: "admin" });
    assert.deepEqual(parseAdminKeyCommand(["retire", "--tenant=synthetic-tenant", "--key-id=key:synthetic"]),
      { command: "retire", tenantId: "synthetic-tenant", keyId: "key:synthetic" });
    for (const options of [[], ["issue"], ["issue", "--tenant=synthetic", "--role=owner"],
      ["issue", "--tenant=synthetic", "--role=read_only", "--app="], ["issue", "--tenant=synthetic", "--role=read_only", "--app=a,b"],
      ["issue", "--tenant=synthetic", "--role=read_only", "--app=a", "--app=b"], ["retire", "--tenant=synthetic", "--key-id=key:a", "--app=a"]])
      assert.throws(() => parseAdminKeyCommand(options), /arguments_invalid/);
  });
  it("maps admin, operator, and read-only roles to the closed capability matrix", () => {
    assert.equal(roleAllows("admin", "administer"), true);
    assert.equal(roleAllows("admin", "operate"), true);
    assert.equal(roleAllows("admin", "read"), true);
    assert.equal(roleAllows("operator", "administer"), false);
    assert.equal(roleAllows("operator", "operate"), true);
    assert.equal(roleAllows("operator", "read"), true);
    assert.equal(roleAllows("read_only", "administer"), false);
    assert.equal(roleAllows("read_only", "operate"), false);
    assert.equal(roleAllows("read_only", "read"), true);
  });

  it("defaults legacy configuration to admin and rejects unknown roles", () => {
    assert.equal(parseAdminRole(undefined), "admin");
    assert.equal(parseAdminRole("operator"), "operator");
    assert.equal(parseAdminRole("read_only"), "read_only");
    assert.throws(() => parseAdminRole("owner"), /admin role/);
    assert.throws(() => assertRoleAllows("read_only", "operate"), /forbidden/);
  });
});
