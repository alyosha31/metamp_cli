import {
	type ApprovalAction,
	type ApprovalRequest,
	type ApprovalStatus,
	type ApprovalsManifest,
	BUILTIN_MANIFEST_NAMESPACES,
	type DatasetColumn,
	type DatasetManifestEntry,
	type DatasetStorageMode,
	type DatasetsManifest,
	DECISION_TYPES,
	type DecisionEntry,
	type DecisionStatus,
	type DecisionsManifest,
	type DecisionType,
	type NamespacedEntry,
	type NamespacedNotesManifest,
	type ProjectManifest,
	type RunManifest,
	type RunStatus,
} from "./schema.ts";

const BUILTIN_NAMESPACE_SET = new Set<string>(BUILTIN_MANIFEST_NAMESPACES);
const DECISION_TYPE_SET = new Set<string>(DECISION_TYPES);
const DECISION_STATUS_SET = new Set<DecisionStatus>(["pending", "approved", "rejected", "superseded"]);
const APPROVAL_STATUS_SET = new Set<ApprovalStatus>(["pending", "approved", "rejected", "superseded"]);
const APPROVAL_ACTION_SET = new Set<ApprovalAction>([
	"write_manifest",
	"write_report",
	"write_recipe",
	"write_artifact",
	"decision",
]);
const RUN_STATUS_SET = new Set<RunStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);
const DATASET_STORAGE_MODE_SET = new Set<DatasetStorageMode>(["copy", "link"]);
const DATASET_COLUMN_TYPE_SET = new Set(["integer", "number", "boolean", "string", "empty"]);

function fail(filePath: string, message: string): never {
	throw new Error(`${filePath}: ${message}`);
}

function asRecord(value: unknown, filePath: string, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		fail(filePath, `${label} must be an object`);
	return value as Record<string, unknown>;
}

function numberField(record: Record<string, unknown>, key: string, filePath: string, label: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) fail(filePath, `${label}.${key} must be a number`);
	return value;
}

function optionalNumberField(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	label: string,
): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) fail(filePath, `${label}.${key} must be a number`);
	return value;
}

function stringField(record: Record<string, unknown>, key: string, filePath: string, label: string): string {
	const value = record[key];
	if (typeof value !== "string") fail(filePath, `${label}.${key} must be a string`);
	return value;
}

function optionalStringField(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	label: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") fail(filePath, `${label}.${key} must be a string`);
	return value;
}

function optionalNullableNumberField(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	label: string,
): number | null | undefined {
	const value = record[key];
	if (value === undefined || value === null) return value as null | undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) fail(filePath, `${label}.${key} must be a number or null`);
	return value;
}

function stringArrayField(record: Record<string, unknown>, key: string, filePath: string, label: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		fail(filePath, `${label}.${key} must be a string array`);
	}
	return [...value] as string[];
}

function optionalStringArrayField(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	label: string,
): string[] | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		fail(filePath, `${label}.${key} must be a string array`);
	}
	return [...value] as string[];
}

function recordField(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	label: string,
): Record<string, unknown> {
	return asRecord(record[key], filePath, `${label}.${key}`);
}

function optionalRecordField(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	label: string,
): Record<string, unknown> | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return asRecord(value, filePath, `${label}.${key}`);
}

function validateSchemaVersion(record: Record<string, unknown>, filePath: string, label: string): number {
	const schemaVersion = numberField(record, "schemaVersion", filePath, label);
	if (schemaVersion !== 1) {
		throw new Error(`Unsupported .metamp manifest schema version at ${filePath}: ${schemaVersion}`);
	}
	return schemaVersion;
}

function validateManifestNamespace(value: string, filePath: string): string {
	if (BUILTIN_NAMESPACE_SET.has(value) || /^custom\.[a-z0-9][a-z0-9._-]*$/.test(value)) return value;
	fail(filePath, `manifest namespace ${value} is invalid`);
}

function validateDatasetColumn(value: unknown, filePath: string): DatasetColumn {
	const record = asRecord(value, filePath, "dataset column");
	const inferredType = optionalStringField(record, "inferredType", filePath, "dataset column");
	if (inferredType && !DATASET_COLUMN_TYPE_SET.has(inferredType)) {
		fail(filePath, `dataset column inferredType ${inferredType} is invalid`);
	}
	return {
		name: stringField(record, "name", filePath, "dataset column"),
		inferredType: inferredType as DatasetColumn["inferredType"],
		nonEmptyCount: optionalNumberField(record, "nonEmptyCount", filePath, "dataset column"),
	};
}

function validateDatasetEntry(value: unknown, filePath: string): DatasetManifestEntry {
	const record = asRecord(value, filePath, "dataset entry");
	const storageMode = stringField(record, "storageMode", filePath, "dataset entry");
	if (!DATASET_STORAGE_MODE_SET.has(storageMode as DatasetStorageMode)) {
		fail(filePath, `dataset entry storageMode ${storageMode} is invalid`);
	}
	const columnsValue = record.columns;
	if (!Array.isArray(columnsValue)) fail(filePath, "dataset entry.columns must be an array");
	return {
		id: stringField(record, "id", filePath, "dataset entry"),
		originalPath: stringField(record, "originalPath", filePath, "dataset entry"),
		storedPath: stringField(record, "storedPath", filePath, "dataset entry"),
		storageMode: storageMode as DatasetStorageMode,
		fileType: stringField(record, "fileType", filePath, "dataset entry"),
		sizeBytes: numberField(record, "sizeBytes", filePath, "dataset entry"),
		contentHash: stringField(record, "contentHash", filePath, "dataset entry"),
		columns: columnsValue.map((column) => validateDatasetColumn(column, filePath)),
		profileArtifactPath: optionalStringField(record, "profileArtifactPath", filePath, "dataset entry"),
		createdAt: stringField(record, "createdAt", filePath, "dataset entry"),
		updatedAt: stringField(record, "updatedAt", filePath, "dataset entry"),
		warning: optionalStringField(record, "warning", filePath, "dataset entry"),
	};
}

function validateDecisionEntry(value: unknown, filePath: string): DecisionEntry {
	const record = asRecord(value, filePath, "decision entry");
	const type = stringField(record, "type", filePath, "decision entry");
	if (!DECISION_TYPE_SET.has(type)) fail(filePath, `decision entry type ${type} is invalid`);
	const status = stringField(record, "status", filePath, "decision entry");
	if (!DECISION_STATUS_SET.has(status as DecisionStatus)) fail(filePath, `decision entry status ${status} is invalid`);
	const decidedBy = stringField(record, "decidedBy", filePath, "decision entry");
	if (!["user", "copilot", "default"].includes(decidedBy)) {
		fail(filePath, `decision entry decidedBy ${decidedBy} is invalid`);
	}
	return {
		id: stringField(record, "id", filePath, "decision entry"),
		type: type as DecisionType,
		proposedValue: record.proposedValue,
		approvedValue: record.approvedValue,
		status: status as DecisionStatus,
		rationale: optionalStringField(record, "rationale", filePath, "decision entry"),
		decidedBy: decidedBy as DecisionEntry["decidedBy"],
		timestamp: stringField(record, "timestamp", filePath, "decision entry"),
		sourceRunId: optionalStringField(record, "sourceRunId", filePath, "decision entry"),
		sourceArtifactPath: optionalStringField(record, "sourceArtifactPath", filePath, "decision entry"),
	};
}

function validateNamespacedEntry(value: unknown, filePath: string): NamespacedEntry {
	const record = asRecord(value, filePath, "namespaced entry");
	return {
		id: stringField(record, "id", filePath, "namespaced entry"),
		owner: stringField(record, "owner", filePath, "namespaced entry"),
		kind: stringField(record, "kind", filePath, "namespaced entry"),
		value: record.value,
		rationale: optionalStringField(record, "rationale", filePath, "namespaced entry"),
		evidence: optionalStringArrayField(record, "evidence", filePath, "namespaced entry"),
		createdAt: stringField(record, "createdAt", filePath, "namespaced entry"),
		updatedAt: stringField(record, "updatedAt", filePath, "namespaced entry"),
	};
}

function validateApprovalRequest(value: unknown, filePath: string): ApprovalRequest {
	const record = asRecord(value, filePath, "approval request");
	const action = stringField(record, "action", filePath, "approval request");
	if (!APPROVAL_ACTION_SET.has(action as ApprovalAction)) fail(filePath, `approval action ${action} is invalid`);
	const status = stringField(record, "status", filePath, "approval request");
	if (!APPROVAL_STATUS_SET.has(status as ApprovalStatus)) fail(filePath, `approval status ${status} is invalid`);
	return {
		id: stringField(record, "id", filePath, "approval request"),
		requester: stringField(record, "requester", filePath, "approval request"),
		action: action as ApprovalAction,
		targetResource: stringField(record, "targetResource", filePath, "approval request"),
		targetOwner: optionalStringField(record, "targetOwner", filePath, "approval request"),
		proposedValue: record.proposedValue,
		rationale: stringField(record, "rationale", filePath, "approval request"),
		status: status as ApprovalStatus,
		createdAt: stringField(record, "createdAt", filePath, "approval request"),
		decidedAt: optionalStringField(record, "decidedAt", filePath, "approval request"),
	};
}

function validateMetricsRecord(value: unknown, filePath: string): Record<string, number | string | boolean | null> {
	const record = asRecord(value, filePath, "run manifest.metrics");
	for (const [key, metricValue] of Object.entries(record)) {
		if (
			typeof key !== "string" ||
			!(
				typeof metricValue === "number" ||
				typeof metricValue === "string" ||
				typeof metricValue === "boolean" ||
				metricValue === null
			)
		) {
			fail(filePath, `run manifest.metrics.${key} must be a scalar or null`);
		}
	}
	return record as Record<string, number | string | boolean | null>;
}

function validateStringRecord(value: unknown, filePath: string, label: string): Record<string, string> {
	const record = asRecord(value, filePath, label);
	for (const [key, entryValue] of Object.entries(record)) {
		if (typeof key !== "string" || typeof entryValue !== "string") fail(filePath, `${label}.${key} must be a string`);
	}
	return record as Record<string, string>;
}

export function validateProjectManifest(value: unknown, filePath: string): ProjectManifest {
	const record = asRecord(value, filePath, "project manifest");
	validateSchemaVersion(record, filePath, "project manifest");
	return {
		schemaVersion: 1,
		projectId: stringField(record, "projectId", filePath, "project manifest"),
		name: stringField(record, "name", filePath, "project manifest"),
		root: stringField(record, "root", filePath, "project manifest"),
		createdAt: stringField(record, "createdAt", filePath, "project manifest"),
		updatedAt: stringField(record, "updatedAt", filePath, "project manifest"),
		objective: optionalStringField(record, "objective", filePath, "project manifest"),
		activeDatasetId: optionalStringField(record, "activeDatasetId", filePath, "project manifest"),
		activeTargetColumn: optionalStringField(record, "activeTargetColumn", filePath, "project manifest"),
		activeMetric: optionalStringField(record, "activeMetric", filePath, "project manifest"),
		activeSplitStrategy: optionalStringField(record, "activeSplitStrategy", filePath, "project manifest"),
		promotedRunId: optionalStringField(record, "promotedRunId", filePath, "project manifest"),
	};
}

export function validateDatasetsManifest(value: unknown, filePath: string): DatasetsManifest {
	const record = asRecord(value, filePath, "datasets manifest");
	validateSchemaVersion(record, filePath, "datasets manifest");
	const datasetsValue = record.datasets;
	if (!Array.isArray(datasetsValue)) fail(filePath, "datasets manifest.datasets must be an array");
	return { schemaVersion: 1, datasets: datasetsValue.map((entry) => validateDatasetEntry(entry, filePath)) };
}

export function validateDecisionsManifest(value: unknown, filePath: string): DecisionsManifest {
	const record = asRecord(value, filePath, "decisions manifest");
	validateSchemaVersion(record, filePath, "decisions manifest");
	const decisionsValue = record.decisions;
	if (!Array.isArray(decisionsValue)) fail(filePath, "decisions manifest.decisions must be an array");
	return { schemaVersion: 1, decisions: decisionsValue.map((entry) => validateDecisionEntry(entry, filePath)) };
}

export function validateApprovalsManifest(value: unknown, filePath: string): ApprovalsManifest {
	const record = asRecord(value, filePath, "approvals manifest");
	validateSchemaVersion(record, filePath, "approvals manifest");
	const approvalsValue = record.approvals;
	if (!Array.isArray(approvalsValue)) fail(filePath, "approvals manifest.approvals must be an array");
	return { schemaVersion: 1, approvals: approvalsValue.map((entry) => validateApprovalRequest(entry, filePath)) };
}

export function validateNamespacedNotesManifest(value: unknown, filePath: string): NamespacedNotesManifest {
	const record = asRecord(value, filePath, "namespaced manifest");
	validateSchemaVersion(record, filePath, "namespaced manifest");
	const namespace = stringField(record, "namespace", filePath, "namespaced manifest");
	const entriesValue = record.entries;
	if (!Array.isArray(entriesValue)) fail(filePath, "namespaced manifest.entries must be an array");
	return {
		schemaVersion: 1,
		namespace: validateManifestNamespace(namespace, filePath) as NamespacedNotesManifest["namespace"],
		entries: entriesValue.map((entry) => validateNamespacedEntry(entry, filePath)),
	};
}

export function validateRunManifest(value: unknown, filePath: string): RunManifest {
	const record = asRecord(value, filePath, "run manifest");
	validateSchemaVersion(record, filePath, "run manifest");
	const status = stringField(record, "status", filePath, "run manifest");
	if (!RUN_STATUS_SET.has(status as RunStatus)) fail(filePath, `run manifest status ${status} is invalid`);
	const command = stringArrayField(record, "command", filePath, "run manifest");
	const inputs = recordField(record, "inputs", filePath, "run manifest");
	const outputs = recordField(record, "outputs", filePath, "run manifest");
	const python = optionalRecordField(record, "python", filePath, "run manifest");
	if (python) {
		stringField(python, "executable", filePath, "run manifest.python");
		optionalStringField(python, "version", filePath, "run manifest.python");
	}
	return {
		schemaVersion: 1,
		runId: stringField(record, "runId", filePath, "run manifest"),
		status: status as RunStatus,
		command,
		cwd: stringField(record, "cwd", filePath, "run manifest"),
		python: python
			? {
					executable: stringField(python, "executable", filePath, "run manifest.python"),
					version: optionalStringField(python, "version", filePath, "run manifest.python"),
				}
			: undefined,
		recipePath: stringField(record, "recipePath", filePath, "run manifest"),
		inputs,
		outputs,
		metrics: validateMetricsRecord(record.metrics, filePath),
		startedAt: optionalStringField(record, "startedAt", filePath, "run manifest"),
		endedAt: optionalStringField(record, "endedAt", filePath, "run manifest"),
		stdoutPath: stringField(record, "stdoutPath", filePath, "run manifest"),
		stderrPath: stringField(record, "stderrPath", filePath, "run manifest"),
		logsPath: stringField(record, "logsPath", filePath, "run manifest"),
		codeHashes: validateStringRecord(record.codeHashes, filePath, "run manifest.codeHashes"),
		parentRunId: optionalStringField(record, "parentRunId", filePath, "run manifest"),
		exitCode: optionalNullableNumberField(record, "exitCode", filePath, "run manifest"),
		error: optionalStringField(record, "error", filePath, "run manifest"),
	};
}
