import { readYamlFile, writeYamlFile } from "../manifests/io.ts";
import type { DatasetsManifest, DecisionsManifest, ProjectManifest, ProjectState } from "../manifests/schema.ts";
import { listRuns } from "../runs/run-store.ts";
import { getMetampPaths } from "./paths.ts";

export async function loadProjectState(root: string): Promise<ProjectState> {
	const paths = getMetampPaths(root);
	const [project, datasets, decisions, runs] = await Promise.all([
		readYamlFile<ProjectManifest>(paths.projectManifest),
		readYamlFile<DatasetsManifest>(paths.datasetsManifest),
		readYamlFile<DecisionsManifest>(paths.decisionsManifest),
		listRuns(root),
	]);
	return { project, datasets, decisions, runs };
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
	const promoted = state.project.promotedRunId ?? "none";
	const datasets =
		state.datasets.datasets.length === 0 ? "none" : state.datasets.datasets.map((dataset) => dataset.id).join(", ");
	return [
		`Project: ${state.project.name}`,
		`Datasets: ${datasets}`,
		`Active target: ${state.project.activeTargetColumn ?? "unset"}`,
		`Metric: ${state.project.activeMetric ?? "unset"}`,
		`Split: ${state.project.activeSplitStrategy ?? "unset"}`,
		`Pending decisions: ${pending.length}`,
		`Latest run: ${latestRunSummary(state)}`,
		`Promoted run: ${promoted}`,
	].join("\n");
}
