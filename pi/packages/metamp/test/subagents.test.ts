import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initProject } from "../src/project/init.ts";
import { getMetampSubagent, listMetampSubagents } from "../src/subagents/agents.ts";
import { discoverMetampSubagents } from "../src/subagents/discovery.ts";
import {
	buildMetampSubagentPrompt,
	cleanSubagentOutput,
	getHarnessInvocation,
	parseSubagentJsonLine,
	parseSubagentProgressLine,
	subagentTextResult,
} from "../src/subagents/runner.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-subagents-"));
}

describe("Metamp horizontal subagents", () => {
	it("bundles broad data science specialists with short names", () => {
		const names = listMetampSubagents().map((agent) => agent.name);

		expect(names).toEqual([
			"data-profiler",
			"schema-detective",
			"quality-auditor",
			"leakage-auditor",
			"experiment-designer",
			"result-interpreter",
			"reproducibility-auditor",
			"report-writer",
		]);
	});

	it("defines each bundled agent with ownership, tools, prompt, and description", () => {
		for (const agent of listMetampSubagents()) {
			expect(agent.description.length).toBeGreaterThan(20);
			expect(agent.prompt).toContain("Metamp");
			expect(agent.tools).toContain("metamp_update_owned_manifest");
			expect(agent.owns.manifests.length).toBeGreaterThan(0);
		}
		expect(getMetampSubagent("leakage-auditor")?.prompt).toContain("leakage");
		expect(getMetampSubagent("metamp-leakage-auditor")).toBeUndefined();
	});

	it("generates ownership-aware prompts", async () => {
		const cwd = await tempRoot();
		const project = await initProject("prompts", cwd);
		const agent = (await discoverMetampSubagents({ projectRoot: project.root })).find(
			(candidate) => candidate.name === "schema-detective",
		);
		expect(agent).toBeDefined();

		const prompt = await buildMetampSubagentPrompt(project.root, agent!);

		expect(prompt).toContain("You are schema-detective.");
		expect(prompt).toContain(".metamp/schema.yaml");
		expect(prompt).toContain("Do not include acknowledgements");
	});

	it("invokes the coding-agent harness instead of the Metamp CLI", () => {
		const invocation = getHarnessInvocation(["--mode", "json"]);

		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args[0]).toMatch(
			/packages[\\/]coding-agent[\\/]src[\\/]cli\.ts|packages[\\/]coding-agent[\\/]dist[\\/]cli\.js/,
		);
		expect(invocation.args).toContain("--mode");
	});

	it("parses only assistant output and assistant errors from JSON events", () => {
		expect(
			parseSubagentJsonLine(
				JSON.stringify({
					type: "message_end",
					message: { role: "user", content: [{ type: "text", text: "task" }] },
				}),
			),
		).toEqual({ role: "user", text: "task", error: undefined });
		expect(
			parseSubagentJsonLine(
				JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "findings" }] },
				}),
			),
		).toEqual({ role: "assistant", text: "findings", error: undefined });
		expect(
			parseSubagentJsonLine(
				JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [], errorMessage: "model failed" },
				}),
			),
		).toEqual({ role: "assistant", text: undefined, error: "model failed" });
	});

	it("parses subagent progress events for visible TUI streaming", () => {
		expect(
			parseSubagentProgressLine(
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "checking manifests" },
				}),
			),
		).toEqual({ type: "thinking", text: "checking manifests" });
		expect(
			parseSubagentProgressLine(
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "finding" },
				}),
			),
		).toEqual({ type: "text", text: "finding" });
		expect(
			parseSubagentProgressLine(JSON.stringify({ type: "tool_execution_start", toolName: "metamp_project_state" })),
		).toEqual({ type: "tool", text: "tool started: metamp_project_state" });
	});

	it("strips standalone subagent completion receipts", () => {
		expect(cleanSubagentOutput("Findings\ncompleted")).toBe("Findings");
		expect(cleanSubagentOutput("done\nFindings")).toBe("Findings");
		expect(cleanSubagentOutput("Findings\nThis column is complete enough to use.")).toBe(
			"Findings\nThis column is complete enough to use.",
		);
	});

	it("formats failed subagent output for tool results", () => {
		const result = subagentTextResult({
			agent: "data-profiler",
			task: "profile data",
			exitCode: 1,
			output: "",
			stderr: "model unavailable",
		});

		expect(result.content).toEqual([{ type: "text", text: "model unavailable" }]);
	});
});
