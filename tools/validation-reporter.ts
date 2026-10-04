import { tap, type TestEvent } from "node:test/reporters";

// Keep Node's standard aggregated TAP output. Only defer the measured inventory
// until the entire run succeeds; never import the validator and evaluate it again.
export default async function* validationReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let inventory: string | undefined;
  let successful = false;
  async function* events(): AsyncGenerator<TestEvent, void> {
    for await (const event of source) {
      if (event.type === "test:stdout" && event.data.message.startsWith("Validated ")) {
        inventory = event.data.message.trim();
        continue;
      }
      if (event.type === "test:summary" && event.data.file === undefined) successful = event.data.success;
      yield event;
    }
  }
  yield* tap(events());
  if (successful) {
    if (!inventory) throw new Error("Successful contract tests did not supply their measured inventory");
    yield `${inventory}\n`;
  }
}
