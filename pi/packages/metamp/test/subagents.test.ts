import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnOverride } = vi.hoisted(() => ({
	spawnOverride: { current: null as null | ((...args: unknown[]) => unknown) },
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: ((...args: Parameters<typeof actual.spawn>) => {
			if (spawnOverride.current) return spawnOverride.current(...args) as ReturnType<typeof actual.spawn>;
			return actual.spawn(...args);
		}) as typeof actual.spawn,
	};
});

import { initProject } from "../src/project/init.ts";
import { getMetampSubagent, listMetampSubagents } from "../src/subagents/agents.ts";
import { discoverMetampSubagents } from "../src/subagents/discovery.ts";
import {
	applyMetampSubagentProgress,
	createMetampSubagentProgressState,
	snapshotMetampSubagentProgress,
} from "../src/subagents/progress.ts";
import {
	buildMetampSubagentPrompt,
	cleanSubagentOutput,
	getHarnessInvocation,
	parseSubagentJsonLine,
	parseSubagentProgressLine,
	runMetampSubagent,
	subagentTextResult,
} from "../src/subagents/runner.ts";

afterEach(() => {
	spawnOverride.current = null;
	vi.clearAllMocks();
});

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-subagents-"));
}

function createMockChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn(() => true);
	return child;
}

function emitJson(child: { stdout: PassThrough }, payload: unknown): void {
	child.stdout.write(`${JSON.stringify(payload)}\n`);
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

	it("parses rich subagent progress events for visible TUI streaming", () => {
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
		).toEqual({ type: "tool_started", text: "tool started: metamp_project_state", toolName: "metamp_project_state" });
		expect(
			parseSubagentProgressLine(
				JSON.stringify({ type: "tool_execution_end", toolName: "metamp_project_state", isError: false }),
			),
		).toEqual({
			type: "tool_finished",
			text: "tool finished: metamp_project_state",
			toolName: "metamp_project_state",
		});
	});

	it("reduces rich progress into reusable overlay and tool snapshots", () => {
		const state = createMetampSubagentProgressState("data-profiler", "profile data");
		applyMetampSubagentProgress(state, { type: "started", text: "starting data-profiler" });
		applyMetampSubagentProgress(state, { type: "thinking", text: "checking manifests" });
		applyMetampSubagentProgress(state, { type: "tool_started", text: "tool started: read", toolName: "read" });
		applyMetampSubagentProgress(state, { type: "tool_finished", text: "tool finished: read", toolName: "read" });
		applyMetampSubagentProgress(state, { type: "text", text: "summary" });
		applyMetampSubagentProgress(state, { type: "completed", text: "subagent completed", exitCode: 0 });

		const snapshot = snapshotMetampSubagentProgress(state);
		expect(snapshot.status).toBe("completed");
		expect(snapshot.recentTools).toEqual(["read"]);
		expect(snapshot.activity).toEqual([
			"starting data-profiler",
			"tool started: read",
			"tool finished: read",
			"subagent completed",
		]);
		expect(snapshot.drafting).toBe("summary");
	});

	it("aggregates multiple assistant messages in order", async () => {
		const cwd = await tempRoot();
		const project = await initProject("aggregate", cwd);
		spawnOverride.current = () => {
			const child = createMockChild();
			queueMicrotask(() => {
				emitJson(child, {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "First" }] },
				});
				emitJson(child, {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Second" }] },
				});
				child.emit("close", 0);
			});
			return child;
		};

		const result = await runMetampSubagent({
			projectRoot: project.root,
			agentName: "data-profiler",
			task: "profile",
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("First\n\nSecond");
	});

	it("does not fail solely because stderr had output", async () => {
		const cwd = await tempRoot();
		const project = await initProject("stderr", cwd);
		spawnOverride.current = () => {
			const child = createMockChild();
			queueMicrotask(() => {
				child.stderr.write("warning\n");
				emitJson(child, {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
				});
				setTimeout(() => {
					child.emit("close", 0);
				}, 0);
			});
			return child;
		};

		const result = await runMetampSubagent({
			projectRoot: project.root,
			agentName: "data-profiler",
			task: "profile",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("warning");
	});

	it("treats assistant error events as failures even with zero child exit", async () => {
		const cwd = await tempRoot();
		const project = await initProject("assistant-error", cwd);
		spawnOverride.current = () => {
			const child = createMockChild();
			queueMicrotask(() => {
				emitJson(child, {
					type: "message_end",
					message: { role: "assistant", content: [], errorMessage: "model failed" },
				});
				child.emit("close", 0);
			});
			return child;
		};

		const result = await runMetampSubagent({
			projectRoot: project.root,
			agentName: "data-profiler",
			task: "profile",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("model failed");
	});

	it("aborts child execution and surfaces aborted progress", async () => {
		const cwd = await tempRoot();
		const project = await initProject("abort", cwd);
		const controller = new AbortController();
		const progress: string[] = [];
		let childRef: ReturnType<typeof createMockChild> | undefined;
		spawnOverride.current = () => {
			childRef = createMockChild();
			setTimeout(() => {
				childRef?.emit("close", null);
			}, 10);
			return childRef;
		};

		const promise = runMetampSubagent({
			projectRoot: project.root,
			agentName: "data-profiler",
			task: "profile",
			signal: controller.signal,
			onProgress(event) {
				progress.push(event.type);
			},
		});
		controller.abort();
		const result = await promise;

		expect(childRef?.kill).toHaveBeenCalledWith("SIGTERM");
		expect(result.exitCode).toBe(130);
		expect(result.output).toBe("Subagent aborted.");
		expect(progress).toContain("aborted");
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
