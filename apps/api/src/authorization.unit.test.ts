import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAdminRole } from "./admin-auth.js";
import { assertRoleAllows, roleAllows } from "./authorization.js";

describe("M5 minimum RBAC", () => {
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
