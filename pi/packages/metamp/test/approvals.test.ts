import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createApprovalRequest, readApprovalRequests, recordApprovalRequest } from "../src/approvals/approval-store.ts";
import { initProject } from "../src/project/init.ts";
import { loadProjectState } from "../src/project/state.ts";
import { registerMetampTools } from "../src/tools/metamp-tools.ts";

type CapturedExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: (update: unknown) => void,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>> | AgentToolResult<unknown>;

interface CapturedTool {
	name: string;
	execute: CapturedExecute;
}

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-approvals-"));
}

function captureMetampTools(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	registerMetampTools({
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	return tools;
}

function getCapturedTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

describe("approval request store", () => {
	it("creates durable pending approval requests", async () => {
		const cwd = await tempRoot();
		const project = await initProject("approvals", cwd);

		const approval = await createApprovalRequest(project.root, {
			requester: "schema-detective",
			action: "write_manifest",
			targetResource: ".metamp/leakage.yaml",
			targetOwner: "leakage-auditor",
			proposedValue: { kind: "leakage_risk", value: "post-outcome timestamp" },
			rationale: "Schema evidence suggests a cross-owned leakage note.",
		});
		const manifest = await readApprovalRequests(project.root);
		const state = await loadProjectState(project.root);

		expect(approval.id).toBe("approval_001");
		expect(approval.status).toBe("pending");
		expect(manifest.approvals).toHaveLength(1);
		expect(state.approvals.approvals[0]?.targetOwner).toBe("leakage-auditor");
	});

	it("records approval request lifecycle", async () => {
		const cwd = await tempRoot();
		const project = await initProject("approval-lifecycle", cwd);
		const pending = await createApprovalRequest(project.root, {
			requester: "data-profiler",
			action: "write_report",
			targetResource: "reports/schema/profile.md",
			proposedValue: "profile report",
			rationale: "Cross-scope report write.",
		});

		const rejected = await recordApprovalRequest(project.root, { id: pending.id, status: "rejected" });

		expect(rejected.status).toBe("rejected");
		expect(rejected.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("enforces ownership in domain write tools", async () => {
		const cwd = await tempRoot();
		const project = await initProject("owned-tools", cwd);
		const tools = captureMetampTools();
		const ctx = { cwd: project.root } as unknown as ExtensionContext;

		await getCapturedTool(tools, "metamp_update_owned_manifest").execute(
			"1",
			{
				agent: "schema-detective",
				namespace: "schema",
				entry: { kind: "entity_grain", value: { grain: "customer" }, rationale: "ID column is stable." },
			},
			undefined,
			() => undefined,
			ctx,
		);
		await getCapturedTool(tools, "metamp_write_owned_report").execute(
			"2",
			{
				agent: "data-profiler",
				path: "reports/profiles/summary.md",
				content: "profile summary",
			},
			undefined,
			() => undefined,
			ctx,
		);
		await getCapturedTool(tools, "metamp_update_owned_manifest").execute(
			"3",
			{
				agent: "schema-detective",
				namespace: "leakage",
				entry: { kind: "risk", value: "post-outcome timestamp" },
			},
			undefined,
			() => undefined,
			ctx,
		);

		const state = await loadProjectState(project.root);
		const report = await readFile(path.join(project.root, "reports", "profiles", "summary.md"), "utf8");

		expect(state.namespaceManifests.find((manifest) => manifest.namespace === "schema")?.entries[0]?.kind).toBe(
			"entity_grain",
		);
		expect(report).toBe("profile summary");
		expect(state.approvals.approvals[0]?.targetResource).toBe(".metamp/leakage.yaml");
	});
});
