import { readOptionalYamlFile, readYamlFile, writeYamlFile } from "../manifests/io.ts";
import {
	BUILTIN_MANIFEST_NAMESPACES,
	type BuiltinManifestNamespace,
	METAMP_SCHEMA_VERSION,
	type ProjectManifest,
	type ProjectState,
} from "../manifests/schema.ts";
import {
	validateApprovalsManifest,
	validateDatasetsManifest,
	validateDecisionsManifest,
	validateNamespacedNotesManifest,
	validateProjectManifest,
} from "../manifests/validation.ts";
import { listRuns } from "../runs/run-store.ts";
import { getMetampPaths } from "./paths.ts";

export async function loadProjectState(root: string): Promise<ProjectState> {
	const paths = getMetampPaths(root);
	const [projectRaw, datasetsRaw, decisionsRaw, approvalsRaw, namespaceRaw, runs] = await Promise.all([
		readYamlFile<unknown>(paths.projectManifest),
		readYamlFile<unknown>(paths.datasetsManifest),
		readYamlFile<unknown>(paths.decisionsManifest),
		readOptionalYamlFile<unknown>(paths.approvalsManifest, {
			schemaVersion: METAMP_SCHEMA_VERSION,
			approvals: [],
		}),
		Promise.all(
			BUILTIN_MANIFEST_NAMESPACES.map(async (namespace) => ({
				namespace,
				manifest: await readOptionalYamlFile<unknown>(paths.namespaceManifests[namespace], {
					schemaVersion: METAMP_SCHEMA_VERSION,
					namespace,
					entries: [],
				}),
			})),
		),
		listRuns(root),
	]);
	const project = validateProjectManifest(projectRaw, paths.projectManifest);
	const datasets = validateDatasetsManifest(datasetsRaw, paths.datasetsManifest);
	const decisions = validateDecisionsManifest(decisionsRaw, paths.decisionsManifest);
	const approvals = validateApprovalsManifest(approvalsRaw, paths.approvalsManifest);
	const namespaceManifests = namespaceRaw.map(({ namespace, manifest }) =>
		validateNamespacedNotesManifest(manifest, paths.namespaceManifests[namespace as BuiltinManifestNamespace]),
	);
	return { project, datasets, decisions, namespaceManifests, approvals, runs };
}

export async function saveProjectManifest(root: string, project: ProjectManifest): Promise<void> {
	await writeYamlFile(getMetampPaths(root).projectManifest, project);
}

export function latestRunSummary(state: ProjectState): string {
	const latest = state.runs.at(-1);
	return latest ? `${latest.runId} ${latest.status} ${latest.recipePath}` : "none";
}

export function formatProjectState(state: ProjectState): string {
	const pending = state.decisions.decisions.filter((decision) => decision.status === "pending");
	const pendingApprovals = state.approvals.approvals.filter((approval) => approval.status === "pending");
	const promoted = state.project.promotedRunId ?? "none";
	const datasets =
		state.datasets.datasets.length === 0 ? "none" : state.datasets.datasets.map((dataset) => dataset.id).join(", ");
	const namespaceSummary =
		state.namespaceManifests.length === 0
			? "none"
			: state.namespaceManifests.map((manifest) => `${manifest.namespace}:${manifest.entries.length}`).join(", ");
	return [
		`Project: ${state.project.name}`,
		`Datasets: ${datasets}`,
		`Active target: ${state.project.activeTargetColumn ?? "unset"}`,
		`Metric: ${state.project.activeMetric ?? "unset"}`,
		`Split: ${state.project.activeSplitStrategy ?? "unset"}`,
		`Pending decisions: ${pending.length}`,
		`Pending approvals: ${pendingApprovals.length}`,
		`Namespaces: ${namespaceSummary}`,
		`Latest run: ${latestRunSummary(state)}`,
		`Promoted run: ${promoted}`,
	].join("\n");
}
