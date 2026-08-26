import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headingAnchors, localMarkdownLinks } from "./check-doc-links.js";

describe("documentation link checker", () => {
  it("extracts local links and ignores external destinations", () => {
    assert.deepEqual(
      localMarkdownLinks("[Guide](docs/guide.md#start) [Web](https://example.invalid) [Here](#local)"),
      ["docs/guide.md#start", "#local"],
    );
  });

  it("uses stable GitHub-style anchors including duplicate headings", () => {
    assert.deepEqual(
      [...headingAnchors("# Getting Started\n## Safety & Privacy\n## Safety & Privacy")],
      ["getting-started", "safety-privacy", "safety-privacy-1"],
    );
  });
});
