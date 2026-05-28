export const METAMP_SCHEMA_VERSION = 1;

export type ProblemType = "classification" | "regression" | "forecasting" | "ranking" | "clustering" | "custom";
export type DecisionType =
	| "target"
	| "problem_type"
	| "split"
	| "metric"
	| "cleaning"
	| "leakage"
	| "promotion"
	| "custom";
export type DecisionStatus = "pending" | "approved" | "rejected" | "superseded";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type DatasetStorageMode = "copy" | "link";

export interface ProjectManifest {
	schemaVersion: number;
	projectId: string;
	name: string;
	root: string;
	createdAt: string;
	updatedAt: string;
	objective?: string;
	activeDatasetId?: string;
	activeTargetColumn?: string;
	activeMetric?: string;
	activeSplitStrategy?: string;
	promotedRunId?: string;
}

export interface DatasetColumn {
	name: string;
	inferredType?: "integer" | "number" | "boolean" | "string" | "empty";
	nonEmptyCount?: number;
}

export interface DatasetManifestEntry {
	id: string;
	originalPath: string;
	storedPath: string;
	storageMode: DatasetStorageMode;
	fileType: string;
	sizeBytes: number;
	contentHash: string;
	columns: DatasetColumn[];
	profileArtifactPath?: string;
	createdAt: string;
	updatedAt: string;
	warning?: string;
}

export interface DatasetsManifest {
	schemaVersion: number;
	datasets: DatasetManifestEntry[];
}

export interface DecisionEntry {
	id: string;
	type: DecisionType;
	proposedValue?: unknown;
	approvedValue?: unknown;
	status: DecisionStatus;
	rationale?: string;
	decidedBy: "user" | "copilot" | "default";
	timestamp: string;
	sourceRunId?: string;
	sourceArtifactPath?: string;
}

export interface DecisionsManifest {
	schemaVersion: number;
	decisions: DecisionEntry[];
}

export interface RunManifest {
	schemaVersion: number;
	runId: string;
	status: RunStatus;
	command: string[];
	cwd: string;
	recipePath: string;
	inputs: Record<string, unknown>;
	outputs: Record<string, unknown>;
	metrics: Record<string, number | string | boolean | null>;
	startedAt?: string;
	endedAt?: string;
	stdoutPath: string;
	stderrPath: string;
	logsPath: string;
	codeHashes: Record<string, string>;
	parentRunId?: string;
	exitCode?: number | null;
	error?: string;
}

export interface ProjectState {
	project: ProjectManifest;
	datasets: DatasetsManifest;
	decisions: DecisionsManifest;
	runs: RunManifest[];
}
