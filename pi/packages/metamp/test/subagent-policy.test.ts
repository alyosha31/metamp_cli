import { describe, expect, it } from "vitest";
import { getMetampSubagent } from "../src/subagents/agents.ts";
import {
	canWriteManifest,
	canWriteReport,
	classifyRequestedAction,
	decisionAuthority,
} from "../src/subagents/policy.ts";

describe("Metamp subagent policy", () => {
	it("allows agents to write only owned manifests and report directories", () => {
		const schema = getMetampSubagent("schema-detective");
		expect(schema).toBeDefined();

		expect(canWriteManifest(schema!, "schema")).toBe(true);
		expect(canWriteManifest(schema!, "leakage")).toBe(false);
		expect(canWriteReport(schema!, "reports/schema/grain.md")).toBe(true);
		expect(canWriteReport(schema!, "reports/schema/../leakage/risk.md")).toBe(false);
	});

	it("classifies cross-owned safe writes as approval requests", () => {
		const leakage = getMetampSubagent("leakage-auditor");
		expect(leakage).toBeDefined();

		expect(classifyRequestedAction(leakage!, { kind: "write_manifest", namespace: "leakage" })).toBe("allowed");
		expect(classifyRequestedAction(leakage!, { kind: "write_manifest", namespace: "schema" })).toBe(
			"approval_required",
		);
		expect(classifyRequestedAction(leakage!, { kind: "write_report", relativePath: "reports/schema/risk.md" })).toBe(
			"approval_required",
		);
		expect(classifyRequestedAction(leakage!, { kind: "write_report", relativePath: "../escape.md" })).toBe("denied");
	});

	it("exposes decision proposal authority without silently approving", () => {
		const experiment = getMetampSubagent("experiment-designer");
		const reportWriter = getMetampSubagent("report-writer");
		expect(experiment).toBeDefined();
		expect(reportWriter).toBeDefined();

		expect(decisionAuthority(experiment!, "metric")).toBe("propose");
		expect(classifyRequestedAction(experiment!, { kind: "decision", decisionType: "metric", mode: "propose" })).toBe(
			"allowed",
		);
		expect(classifyRequestedAction(experiment!, { kind: "decision", decisionType: "metric", mode: "approve" })).toBe(
			"approval_required",
		);
		expect(decisionAuthority(reportWriter!, "target")).toBe("none");
		expect(
			classifyRequestedAction(reportWriter!, { kind: "decision", decisionType: "target", mode: "propose" }),
		).toBe("approval_required");
	});
});
