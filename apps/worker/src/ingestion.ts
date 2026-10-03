/** Public production ingestion boundary; privileged fixture support has a separate entrypoint. */
export { ingestRuntimeBatch } from "./ingestion/application.js";
export type { RuntimeIngestionResult } from "./ingestion/model.js";
