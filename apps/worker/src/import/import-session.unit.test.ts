import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { executeImportSession, prepareImportSession } from "./import-session.js";

const mappingBytes = readFileSync("examples/mappings/synthetic-provider-click.json");
const sourceText = readFileSync("examples/synthetic/mmp-raw-events.json", "utf8");
const privateRowValue = "synthetic-private-row-value";
const sourceBytes = Buffer.from(sourceText.replace("synthetic-import-event-1", privateRowValue));

describe("confirmation-bound import session", () => {
  it("previews exact input bytes without opening a database pool", async () => {
    let poolCalls = 0;
    const poolFactory = (): Pool => {
      poolCalls += 1;
      throw new Error("preview must not open a database pool");
    };
    const prepared = prepareImportSession({ mappingBytes, sourceBytes });
    const repeated = prepareImportSession({ mappingBytes, sourceBytes });
    const mappingWhitespace = prepareImportSession({
      mappingBytes: Buffer.concat([mappingBytes, Buffer.from("\n")]),
      sourceBytes,
    });
    const sourceWhitespace = prepareImportSession({
      mappingBytes,
      sourceBytes: Buffer.concat([sourceBytes, Buffer.from("\n")]),
    });
    const output = await executeImportSession({ prepared, poolFactory });

    assert.equal(poolCalls, 0);
    assert.equal(output.format, "openmasu-import-session-v1");
    assert.equal(output.mode, "preview");
    assert.equal(output.persistence, "none");
    assert.deepEqual(output.preview.rows, {
      read: 1, selected: 1, filtered: 0, accepted: 1, rejected: 0,
    });
    assert.match(output.mapping_digest, /^[a-f0-9]{64}$/);
    assert.match(output.source_digest, /^[a-f0-9]{64}$/);
    assert.match(output.confirmation_token, /^[a-f0-9]{64}$/);
    assert.equal(output.confirmation_token, repeated.output.confirmation_token);
    assert.notEqual(output.confirmation_token, mappingWhitespace.output.confirmation_token);
    assert.notEqual(output.confirmation_token, sourceWhitespace.output.confirmation_token);
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes(privateRowValue), false);
    assert.equal(serialized.includes(process.cwd()), false);
  });

  it("rejects a stale confirmation token before opening a database pool", async () => {
    let poolCalls = 0;
    const poolFactory = (): Pool => {
      poolCalls += 1;
      throw new Error("invalid confirmation must not open a database pool");
    };
    const prepared = prepareImportSession({ mappingBytes, sourceBytes });
    await assert.rejects(
      executeImportSession({
        prepared,
        confirmationToken: "0".repeat(64),
        poolFactory,
      }),
      /confirmation_token_invalid/,
    );
    assert.equal(poolCalls, 0);
  });
});
