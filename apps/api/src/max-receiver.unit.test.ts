import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSafeMaxTemplate, expectedMaxTokenAll } from "./max-receiver.js";

describe("MAX receiver security envelope", () => {
  it("derives EVENT_TOKEN_ALL deterministically without token parameters", () => {
    const parameters = new URLSearchParams("event_id=abc&revenue=1.25&cc=US");
    const first = expectedMaxTokenAll(parameters, "synthetic-event-key");
    const reordered = expectedMaxTokenAll(new URLSearchParams("cc=US&event_id=abc&revenue=1.25"), "synthetic-event-key");
    assert.equal(first, reordered);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  it("fails startup when denied advertising macros appear", () => {
    for (const macro of ["{IDFA}", "{IDFV}", "{IP}"]) {
      assert.throws(() => assertSafeMaxTemplate(`https://example.test/postback?value=${macro}`), /denied macro/);
    }
    assert.doesNotThrow(() => assertSafeMaxTemplate("https://example.test/postback?event_id={EVENT_ID}"));
  });
});
