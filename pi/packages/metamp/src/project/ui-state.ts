import type { ProjectState } from "../manifests/schema.ts";

export interface MetampUiState {
	projectSummary: string;
	pendingDecisionCount: number;
	pendingApprovalCount: number;
	latestRunSummary: string;
	promotedRunSummary: string;
	specialistCommands: readonly string[];
	specialistSummary: string;
	statusLine: string;
	statusText: string;
}

function latestRunSummary(state: ProjectState): string {
	const latest = state.runs.at(-1);
	return latest ? `${latest.runId} ${latest.status} ${latest.recipePath}` : "none";
}

function promotedRunSummary(state: ProjectState): string {
	const promotedRunId = state.project.promotedRunId;
	if (!promotedRunId) return "none";
	const promoted = state.runs.find((run) => run.runId === promotedRunId);
	return promoted ? `${promoted.runId} ${promoted.status} ${promoted.recipePath}` : promotedRunId;
}

export function deriveMetampUiState(state: ProjectState, specialistCommands: readonly string[]): MetampUiState {
	const pendingDecisionCount = state.decisions.decisions.filter((decision) => decision.status === "pending").length;
	const pendingApprovalCount = state.approvals.approvals.filter((approval) => approval.status === "pending").length;
	const projectSummary = `${state.project.name} · ${state.datasets.datasets.length} datasets · ${state.runs.length} runs`;
	const latest = latestRunSummary(state);
	const promoted = promotedRunSummary(state);
	const specialistSummary = specialistCommands.length > 0 ? specialistCommands.join(", ") : "none";
	return {
		projectSummary,
		pendingDecisionCount,
		pendingApprovalCount,
		latestRunSummary: latest,
		promotedRunSummary: promoted,
		specialistCommands,
		specialistSummary,
		statusLine: `${projectSummary} · ${pendingDecisionCount} decisions · ${pendingApprovalCount} approvals`,
		statusText: [
			`Project: ${projectSummary}`,
			`Pending decisions: ${pendingDecisionCount}`,
			`Pending approvals: ${pendingApprovalCount}`,
			`Latest run: ${latest}`,
			`Promoted run: ${promoted}`,
			`Specialists: ${specialistSummary}`,
		].join("\n"),
	};
}

export function nextMetampPlanStep(state: ProjectState): string {
	return state.project.activeTargetColumn
		? "Run or compare recipes against the approved metric."
		: "Approve a target column and problem type before training.";
}
