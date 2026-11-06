import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertDsarResponseSafe, parseDsarRequest } from "./dsar.js";
import { decodeDsarCursor, encodeDsarCursor, dsarLimits, type DsarPageState } from "./dsar-pagination.js";

describe("subject access and portability", () => {
  it("accepts only an installation-scoped access or portability request", () => {
    assert.deepEqual(parseDsarRequest({ installation_id: "installation:synthetic", request_type: "access" }), {
      installationId: "installation:synthetic", requestType: "access",
    });
    assert.throws(() => parseDsarRequest({
      installation_id: "installation:synthetic", request_type: "access", tenant_id: "tenant:forged",
    }), /dsar_request_invalid/);
    assert.throws(() => parseDsarRequest({ installation_id: "installation:synthetic", request_type: "delete" }), /dsar_request_type_invalid/);
  });

  it("fails closed if a portable response exposes protected identifiers", () => {
    assert.doesNotThrow(() => assertDsarResponseSafe({ records: [{ record_ref: "a".repeat(64) }] }));
    assert.throws(() => assertDsarResponseSafe({ raw_payload_ref: "encrypted:synthetic" }), /dsar_forbidden_field/);
    assert.throws(() => assertDsarResponseSafe({ transaction_id: "transaction:synthetic" }), /dsar_forbidden_field/);
  });

  it("requires explicit bounded pagination and rejects oversized or ambiguous requests", () => {
    const base={installation_id:"installation:synthetic",request_type:"portability"};
    assert.equal(parseDsarRequest({...base,pagination:"cursor_v1"}).pageSize,200);
    for (const page_size of [0,-1,501,1.5,"10"]) assert.throws(()=>parseDsarRequest({...base,pagination:"cursor_v1",page_size}));
    assert.throws(()=>parseDsarRequest({...base,cursor:"opaque"}),/pagination_required/);
    assert.throws(()=>parseDsarRequest({...base,pagination:"cursor_v1",cursor:"a".repeat(dsarLimits.cursorBytes+1)}));
  });

  it("keeps cursor state opaque and rejects tampering before any database query", () => {
    const state={version:1,scope:"synthetic",requestId:"dsar:synthetic",cutoff:"2026-11-06T00:00:00.000Z",
      expires:Date.parse("2026-11-06T01:00:00.000Z"),epoch:"synthetic",database:"synthetic",snapshot:"1:2:",
      privacy:"synthetic",stage:0,after:["2026-11-05T00:00:00.000Z","record:synthetic"]} as DsarPageState;
    const secret="synthetic-cursor-key-not-a-real-credential",cursor=encodeDsarCursor(state,secret);
    assert.doesNotMatch(Buffer.from(cursor,"base64url").toString("utf8"),/record:synthetic/);
    const scope={tenantId:"tenant-a",appId:"app-a",installationId:"installation:synthetic",requestType:"portability",
      installationKeyId:"synthetic-key",sdkKeyId:"synthetic-sdk",installationDigest:"a".repeat(64),cursorSecret:secret};
    assert.throws(()=>decodeDsarCursor(`${cursor.slice(0,50)}!${cursor.slice(51)}`,scope,new Date(state.cutoff)),/cursor_invalid/);
    assert.throws(()=>decodeDsarCursor(cursor,scope,new Date(state.cutoff)),/cursor_invalid/,"scope must be server-bound");
  });
});
