# Contract v0.1 fixture provenance

The JSON files in the 19 numbered directories are reviewed, immutable golden contract examples. They are committed as source artifacts; the validation command never creates, updates, or regenerates them.

Each fixture has one synthetic input and 11 independently asserted output classes:

- raw records
- event deliveries
- logical events
- corrections
- privacy requests
- privacy tombstones
- attribution results
- metric runs
- public fraud-decision envelopes
- non-identifying rejections
- shadow reconciliation results

The validator checks every object against its Draft 2020-12 schema, checks registry references, runs scenario-specific semantic assertions and acceptance assertions, evaluates each input twice in TypeScript, evaluates it independently in Python, and compares RFC 8785 canonical bytes. Deliberate in-memory mutations prove that malformed timestamps, negative ad revenue, unknown registry values, changed golden output, input reorder, paid reinstall evidence, record-ID collisions, ambiguous clicks, and cross-scope references fail validation or fail closed as specified.

The data is synthetic. It contains no external-source format, campaign data, user data, credential, live fraud rule, or operational threshold.

## Adding a fixture

`fixtures/.candidates/` is a gitignored working area for proposed synthetic inputs. It is outside `fixtures/v0.1/` and is not discovered by `npm run validate`.

1. Create `fixtures/.candidates/<NN-name>/input.json`. Use only synthetic data and keep the proposed number and name stable during review.
2. Run `evaluate()` from `tools/evaluator.ts` manually and run `python tools/python_evaluator.py fixtures/.candidates/<NN-name>/input.json` independently. Save neither command's output as an approved golden automatically.
3. Compare the two outputs, review every field by hand against the schemas and contract, and record the derivation of each meaningful expected value in the pull-request description. Resolve any disagreement before promotion.
4. Promote the reviewed input to `fixtures/v0.1/<NN-name>/`, hand-create the 11 `expected_*.json` output files, and update the named scenario assertions and inventory checks in `tools/validate.ts`. Run `npm run validate` before requesting review.

Golden changes must be reviewed separately from evaluator or schema behavior changes whenever practical. The validation command remains read-only and must never promote a candidate or regenerate an expected file.
