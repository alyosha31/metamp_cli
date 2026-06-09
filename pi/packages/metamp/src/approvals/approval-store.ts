import { readOptionalYamlFile, writeYamlFile } from "../manifests/io.ts";
import {
	type ApprovalAction,
	type ApprovalRequest,
	type ApprovalStatus,
	type ApprovalsManifest,
	METAMP_SCHEMA_VERSION,
} from "../manifests/schema.ts";
import { getMetampPaths } from "../project/paths.ts";

function emptyApprovalsManifest(): ApprovalsManifest {
	return { schemaVersion: METAMP_SCHEMA_VERSION, approvals: [] };
}

function nextApprovalId(manifest: ApprovalsManifest): string {
	let max = 0;
	for (const approval of manifest.approvals) {
		const match = /^approval_(\d+)$/.exec(approval.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `approval_${String(max + 1).padStart(3, "0")}`;
}

function assertApprovalTransition(current: ApprovalStatus, next: ApprovalStatus): void {
	if (next === current) return;
	if (next === "pending") throw new Error("Approval record status cannot remain pending");
	if (current !== "pending") throw new Error(`Approval ${current} cannot transition to ${next}`);
}

export interface CreateApprovalRequestInput {
	requester: string;
	action: ApprovalAction;
	targetResource: string;
	targetOwner?: string;
	proposedValue: unknown;
	rationale: string;
}

export interface RecordApprovalRequestInput {
	id: string;
	status: Exclude<ApprovalStatus, "pending">;
}

export async function readApprovalRequests(root: string): Promise<ApprovalsManifest> {
	return readOptionalYamlFile<ApprovalsManifest>(getMetampPaths(root).approvalsManifest, emptyApprovalsManifest());
}

export async function createApprovalRequest(root: string, input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
	const manifest = await readApprovalRequests(root);
	const now = new Date().toISOString();
	const approval: ApprovalRequest = {
		id: nextApprovalId(manifest),
		requester: input.requester,
		action: input.action,
		targetResource: input.targetResource,
		targetOwner: input.targetOwner,
		proposedValue: input.proposedValue,
		rationale: input.rationale,
		status: "pending",
		createdAt: now,
	};
	await writeYamlFile(getMetampPaths(root).approvalsManifest, {
		schemaVersion: METAMP_SCHEMA_VERSION,
		approvals: [...manifest.approvals, approval],
	} satisfies ApprovalsManifest);
	return approval;
}

export async function recordApprovalRequest(root: string, input: RecordApprovalRequestInput): Promise<ApprovalRequest> {
	const manifest = await readApprovalRequests(root);
	const index = manifest.approvals.findIndex((approval) => approval.id === input.id);
	if (index < 0) throw new Error(`Unknown approval request ${input.id}`);
	const current = manifest.approvals[index];
	assertApprovalTransition(current.status, input.status);
	if (current.status === input.status) return current;
	const updated: ApprovalRequest = {
		...current,
		status: input.status,
		decidedAt: new Date().toISOString(),
	};
	const approvals = [...manifest.approvals];
	approvals[index] = updated;
	await writeYamlFile(getMetampPaths(root).approvalsManifest, {
		schemaVersion: METAMP_SCHEMA_VERSION,
		approvals,
	} satisfies ApprovalsManifest);
	return updated;
}
