import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../manifests/schema.ts";
import { getMetampPaths, toProjectRelative } from "../project/paths.ts";
import { loadProjectState } from "../project/state.ts";

export interface HandoffInput {
	goal?: string;
	conversationSummary?: string;
}

function formatValue(value: unknown): string {
	if (value === undefined) return "unset";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

export function buildHandoffMarkdown(state: ProjectState, input: HandoffInput = {}): string {
	const approved = state.decisions.decisions.filter((decision) => decision.status === "approved");
	const pending = state.decisions.decisions.filter((decision) => decision.status === "pending");
	return `# Metamp Handoff

## Goal

${input.goal ?? "Continue the Metamp project from the durable manifests."}

## Current Project State

- Project: ${state.project.name}
- Active dataset: ${state.project.activeDatasetId ?? "unset"}
- Target column: ${state.project.activeTargetColumn ?? "unset"}
- Metric: ${state.project.activeMetric ?? "unset"}
- Split strategy: ${state.project.activeSplitStrategy ?? "unset"}
- Promoted run: ${state.project.promotedRunId ?? "unset"}

## Datasets

${state.datasets.datasets.map((dataset) => `- ${dataset.id}: ${dataset.storedPath} (${dataset.fileType}, ${dataset.sizeBytes} bytes, ${dataset.columns.length} columns)`).join("\n") || "None"}

## Approved Decisions

${approved.map((decision) => `- ${decision.id} ${decision.type}: ${formatValue(decision.approvedValue)}`).join("\n") || "None"}

## Pending Decisions

${pending.map((decision) => `- ${decision.id} ${decision.type}: ${formatValue(decision.proposedValue)}`).join("\n") || "None"}

## Runs

${state.runs.map((run) => `- ${run.runId}: ${run.status} ${run.recipePath} metrics=${JSON.stringify(run.metrics)}`).join("\n") || "None"}

## Artifacts and Reports

${state.runs.flatMap((run) => Object.entries(run.outputs).map(([key, value]) => `- ${run.runId} ${key}: ${formatValue(value)}`)).join("\n") || "None"}

## Known Issues

${input.conversationSummary ?? "No conversation summary was supplied. Reconstruct state from .metamp manifests first."}

## Recommended Next Step

Inspect pending decisions and the latest run before making material ML changes.
`;
}

export async function writeHandoff(root: string, input: HandoffInput = {}): Promise<{ path: string; content: string }> {
	const state = await loadProjectState(root);
	const paths = getMetampPaths(root);
	await mkdir(paths.handoffsDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filePath = path.join(paths.handoffsDir, `handoff_${stamp}.md`);
	const content = buildHandoffMarkdown(state, input);
	await writeFile(filePath, content, "utf8");
	return { path: toProjectRelative(root, filePath), content };
}
