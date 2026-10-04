import assert from "node:assert/strict";
import { it } from "node:test";
import type { TestEvent } from "node:test/reporters";
import validationReporter from "./validation-reporter.js";

it("prints the measured inventory last only after the entire run succeeds", async () => {
  const inventory = "Validated synthetic inventory.";
  async function* events(success: boolean, includeInventory = true): AsyncGenerator<TestEvent, void> {
    if (includeInventory) yield { type: "test:stdout", data: { file: "synthetic-test.ts", message: `${inventory}\n` } };
    yield {
      type: "test:summary",
      data: {
        file: undefined, success, duration_ms: 1,
        counts: { cancelled: 0, passed: success ? 1 : 0, skipped: 0, suites: 0, tests: 1, todo: 0, topLevel: 1 },
      },
    };
  }
  const render = async (source: AsyncIterable<TestEvent>): Promise<string> => {
    let output = "";
    for await (const chunk of validationReporter(source)) output += chunk;
    return output;
  };
  const success = await render(events(true));
  assert.equal(success.trim().split("\n").at(-1), inventory);
  assert.equal(success.split(inventory).length - 1, 1);
  assert.ok(!(await render(events(false))).includes(inventory));
  await assert.rejects(render(events(true, false)), /did not supply their measured inventory/);
});
