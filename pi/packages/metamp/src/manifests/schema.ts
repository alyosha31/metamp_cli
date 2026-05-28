export const METAMP_SCHEMA_VERSION = 1;

export const BUILTIN_MANIFEST_NAMESPACES = [
	"profiles",
	"schema",
	"quality",
	"leakage",
	"experiments",
	"interpretations",
	"reproducibility",
	"reports",
] as const;

export const DECISION_TYPES = [
	"target",
	"problem_type",
	"split",
	"metric",
	"cleaning",
	"leakage",
	"promotion",
	"custom",
] as const;
export type ProblemType = "classification" | "regression" | "forecasting" | "ranking" | "clustering" | "custom";
export type DecisionType = (typeof DECISION_TYPES)[number];
export type DecisionStatus = "pending" | "approved" | "rejected" | "superseded";
export type DecisionAuthority = "none" | "propose" | "approve";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type DatasetStorageMode = "copy" | "link";
export type BuiltinManifestNamespace = (typeof BUILTIN_MANIFEST_NAMESPACES)[number];
export type ManifestNamespace = BuiltinManifestNamespace | `custom.${string}`;
export type ApprovalAction = "write_manifest" | "write_report" | "write_recipe" | "write_artifact" | "decision";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded";

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

export interface NamespacedEntry {
	id: string;
	owner: string;
	kind: string;
	value: unknown;
	rationale?: string;
	evidence?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface NamespacedNotesManifest {
	schemaVersion: number;
	namespace: ManifestNamespace;
	entries: NamespacedEntry[];
}

export interface ApprovalRequest {
	id: string;
	requester: string;
	action: ApprovalAction;
	targetResource: string;
	targetOwner?: string;
	proposedValue: unknown;
	rationale: string;
	status: ApprovalStatus;
	createdAt: string;
	decidedAt?: string;
}

export interface ApprovalsManifest {
	schemaVersion: number;
	approvals: ApprovalRequest[];
}

export interface RunManifest {
	schemaVersion: number;
	runId: string;
	status: RunStatus;
	command: string[];
	cwd: string;
	python?: {
		executable: string;
		version?: string;
	};
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
	namespaceManifests: NamespacedNotesManifest[];
	approvals: ApprovalsManifest;
	runs: RunManifest[];
}
