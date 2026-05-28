export type { ExecutionBackend, RunRecipeInput, RunRecipeResult } from "./execution/backend.ts";
export { LocalPythonExecutionBackend } from "./execution/local-python.ts";
export { createMetampExtension } from "./extension.ts";
export { buildHandoffMarkdown, writeHandoff } from "./handoff/build-handoff.ts";
export type {
	DatasetManifestEntry,
	DecisionEntry,
	ProjectManifest,
	ProjectState,
	RunManifest,
} from "./manifests/schema.ts";
export { parseCsvLine, registerDataset, sniffDatasetColumns } from "./project/datasets.ts";
export { initProject } from "./project/init.ts";
export { findProjectRoot, requireProjectRoot } from "./project/paths.ts";
export { formatProjectState, loadProjectState } from "./project/state.ts";
