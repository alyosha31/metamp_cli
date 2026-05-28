import { writeYamlFile } from "../manifests/io.ts";
import {
	type DecisionEntry,
	type DecisionStatus,
	type DecisionsManifest,
	type DecisionType,
	METAMP_SCHEMA_VERSION,
} from "../manifests/schema.ts";
import { getMetampPaths } from "../project/paths.ts";
import { loadProjectState } from "../project/state.ts";

function nextDecisionId(decisions: DecisionsManifest): string {
	let max = 0;
	for (const decision of decisions.decisions) {
		const match = /^decision_(\d+)$/.exec(decision.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `decision_${String(max + 1).padStart(3, "0")}`;
}

export interface ProposeDecisionInput {
	type: DecisionType;
	proposedValue: unknown;
	rationale?: string;
	sourceRunId?: string;
	sourceArtifactPath?: string;
	decidedBy?: "user" | "copilot" | "default";
}

export async function proposeDecision(root: string, input: ProposeDecisionInput): Promise<DecisionEntry> {
	const state = await loadProjectState(root);
	const now = new Date().toISOString();
	const decision: DecisionEntry = {
		id: nextDecisionId(state.decisions),
		type: input.type,
		proposedValue: input.proposedValue,
		status: "pending",
		rationale: input.rationale,
		decidedBy: input.decidedBy ?? "copilot",
		timestamp: now,
		sourceRunId: input.sourceRunId,
		sourceArtifactPath: input.sourceArtifactPath,
	};
	const decisions: DecisionsManifest = {
		schemaVersion: METAMP_SCHEMA_VERSION,
		decisions: [...state.decisions.decisions, decision],
	};
	await writeYamlFile(getMetampPaths(root).decisionsManifest, decisions);
	return decision;
}

export interface RecordDecisionInput {
	id: string;
	status: DecisionStatus;
	approvedValue?: unknown;
	rationale?: string;
	decidedBy?: "user" | "copilot" | "default";
}

export async function recordDecision(root: string, input: RecordDecisionInput): Promise<DecisionEntry> {
	const state = await loadProjectState(root);
	const index = state.decisions.decisions.findIndex((decision) => decision.id === input.id);
	if (index < 0) {
		throw new Error(`Unknown decision ${input.id}`);
	}
	const now = new Date().toISOString();
	const updated: DecisionEntry = {
		...state.decisions.decisions[index],
		status: input.status,
		approvedValue:
			input.status === "approved"
				? (input.approvedValue ?? state.decisions.decisions[index].proposedValue)
				: input.approvedValue,
		rationale: input.rationale ?? state.decisions.decisions[index].rationale,
		decidedBy: input.decidedBy ?? "user",
		timestamp: now,
	};
	const decisions = [...state.decisions.decisions];
	decisions[index] = updated;
	await writeYamlFile(getMetampPaths(root).decisionsManifest, {
		schemaVersion: METAMP_SCHEMA_VERSION,
		decisions,
	} satisfies DecisionsManifest);
	return updated;
}
