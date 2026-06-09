import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createMetampExtension } from "../src/extension.ts";
import { initProject } from "../src/project/init.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface RecordingApi {
	events: Map<string, EventHandler[]>;
	tools: string[];
	commands: string[];
	on(event: string, handler: EventHandler): void;
	registerTool(tool: { name: string }): void;
	registerCommand(name: string): void;
}

function createRecordingApi(): RecordingApi {
	return {
		events: new Map(),
		tools: [],
		commands: [],
		on(event, handler) {
			const handlers = this.events.get(event) ?? [];
			handlers.push(handler);
			this.events.set(event, handlers);
		},
		registerTool(tool) {
			this.tools.push(tool.name);
		},
		registerCommand(name) {
			this.commands.push(name);
		},
	};
}

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-ext-"));
}

async function writeProjectLocalAgent(root: string, name = "metric-scout"): Promise<void> {
	const agentDir = path.join(root, ".metamp", "agents");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		path.join(agentDir, `${name}.md`),
		`---
name: ${name}
description: Project-local metric scout
---
Inspect project metrics and summarize concerns.
`,
		"utf8",
	);
}

describe("Metamp extension", () => {
	it("registers domain tools and slash commands", async () => {
		const api = createRecordingApi();
		await createMetampExtension()(api as unknown as ExtensionAPI);

		expect(api.tools).toEqual(
			expect.arrayContaining([
				"metamp_project_state",
				"metamp_register_dataset",
				"metamp_propose_decision",
				"metamp_record_decision",
				"metamp_record_approval",
				"metamp_write_owned_report",
				"metamp_update_owned_manifest",
				"metamp_request_cross_scope_change",
				"metamp_list_subagents",
				"metamp_write_recipe",
				"metamp_run_recipe",
				"metamp_read_run",
				"metamp_compare_runs",
				"metamp_promote_run",
				"metamp_handoff_context",
				"metamp_subagent",
			]),
		);
		expect(api.commands).toEqual(
			expect.arrayContaining([
				"metamp-status",
				"metamp-log",
				"metamp-plan",
				"metamp-decision",
				"metamp-approvals",
				"metamp-approval",
				"metamp-run",
				"metamp-runs",
				"metamp-promote",
				"metamp-handoff",
				"metamp-fork",
				"data-profiler",
				"schema-detective",
				"quality-auditor",
				"leakage-auditor",
				"experiment-designer",
				"result-interpreter",
				"reproducibility-auditor",
				"report-writer",
			]),
		);
		expect(api.commands).not.toContain("metamp-data-profiler");
		expect(api.commands).not.toContain("dataset-profiler");
	});

	it("registers project-local subagent commands when launched from a Metamp project", async () => {
		const cwd = await tempRoot();
		const project = await initProject("commands", cwd);
		await writeProjectLocalAgent(project.root);
		const api = createRecordingApi();

		await createMetampExtension({ projectRoot: project.root })(api as unknown as ExtensionAPI);

		expect(api.commands).toContain("metric-scout");
	});

	it("injects manifest-grounded context before agent starts", async () => {
		const cwd = await tempRoot();
		const project = await initProject("context", cwd);
		const api = createRecordingApi();
		await createMetampExtension({ projectRoot: project.root })(api as unknown as ExtensionAPI);
		const handler = api.events.get("before_agent_start")?.[0];
		expect(handler).toBeDefined();

		const result = await handler?.({ systemPrompt: "base" }, { cwd: project.root } as unknown as ExtensionContext);

		expect(result).toEqual(
			expect.objectContaining({
				systemPrompt: expect.stringContaining("Project: context"),
			}),
		);
		expect((result as { systemPrompt?: string } | undefined)?.systemPrompt).toContain("Pending approvals:");
	});

	it("installs the Metamp startup header and logs status inside the TUI", async () => {
		const cwd = await tempRoot();
		const project = await initProject("header", cwd);
		await writeProjectLocalAgent(project.root);
		const api = createRecordingApi();
		await createMetampExtension({ projectRoot: project.root })(api as unknown as ExtensionAPI);
		const handler = api.events.get("session_start")?.[0];
		let headerFactory: unknown;
		let widgetFactory: unknown;
		const notifications: string[] = [];
		const statuses = new Map<string, string | undefined>();
		const hiddenThinkingLabels: string[] = [];
		expect(handler).toBeDefined();

		await handler?.({ reason: "startup" }, {
			cwd: project.root,
			hasUI: true,
			ui: {
				setHeader(factory: unknown) {
					headerFactory = factory;
				},
				setWidget(_key: string, content: unknown) {
					widgetFactory = content;
				},
				setTitle() {},
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
				},
				setHiddenThinkingLabel(label: string) {
					hiddenThinkingLabels.push(label);
				},
				notify(message: string) {
					notifications.push(message);
				},
			},
		} as unknown as ExtensionContext);
		const rendered =
			typeof headerFactory === "function"
				? headerFactory({}, { bold: (text: string) => text, fg: (_color: string, text: string) => text }).render(
						200,
					)
				: [];
		const widgetRendered =
			typeof widgetFactory === "function"
				? widgetFactory({}, { bold: (text: string) => text, fg: (_color: string, text: string) => text }).render(
						200,
					)
				: [];

		expect(rendered.join("\n")).toContain("metamp");
		expect(rendered.join("\n")).toContain("/metric-scout");
		expect(widgetRendered.join("\n")).toContain("metamp");
		expect(widgetRendered.join("\n")).toContain("/metric-scout");
		expect(statuses.get("metamp")).toBe("header · 0 datasets · 0 runs · 0 decisions · 0 approvals");
		expect(hiddenThinkingLabels).toEqual(["Analyzing Metamp project..."]);
		expect(notifications).toEqual([expect.stringContaining("Metamp status")]);
		expect(notifications[0]).toContain("Project: header · 0 datasets · 0 runs");
	});
	it("sets and clears Metamp status keys for tool lifecycle events", async () => {
		const cwd = await tempRoot();
		const project = await initProject("statuses", cwd);
		const api = createRecordingApi();
		await createMetampExtension({ projectRoot: project.root })(api as unknown as ExtensionAPI);
		const startHandler = api.events.get("tool_execution_start")?.[0];
		const endHandler = api.events.get("tool_execution_end")?.[0];
		const statuses = new Map<string, string | undefined>();
		const ctx = {
			cwd: project.root,
			hasUI: true,
			ui: {
				setHeader() {},
				setWidget() {},
				setTitle() {},
				setHiddenThinkingLabel() {},
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
				},
			},
		} as unknown as ExtensionContext;

		expect(startHandler).toBeDefined();
		expect(endHandler).toBeDefined();

		await startHandler?.(
			{
				type: "tool_execution_start",
				toolCallId: "1",
				toolName: "metamp_run_recipe",
				args: { path: "recipes/train.py" },
			},
			ctx,
		);
		expect(statuses.get("metamp-run")).toBe("run recipes/train.py");

		await endHandler?.(
			{
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "metamp_run_recipe",
				args: { path: "recipes/train.py" },
				result: {
					content: [{ type: "text", text: "run_001: succeeded" }],
					details: { runId: "run_001", status: "succeeded", recipePath: "recipes/train.py" },
				},
				isError: false,
			},
			ctx,
		);
		expect(statuses.get("metamp-run")).toBeUndefined();
		expect(statuses.get("metamp")).toBe("statuses · 0 datasets · 0 runs · 0 decisions · 0 approvals");

		await startHandler?.(
			{
				type: "tool_execution_start",
				toolCallId: "2",
				toolName: "metamp_request_cross_scope_change",
				args: { targetResource: "reports/schema/report.md" },
			},
			ctx,
		);
		expect(statuses.get("metamp-approval")).toBe("approval reports/schema/report.md");

		await endHandler?.(
			{
				type: "tool_execution_end",
				toolCallId: "2",
				toolName: "metamp_request_cross_scope_change",
				args: { targetResource: "reports/schema/report.md" },
				result: {
					content: [{ type: "text", text: "Created approval request approval_001" }],
					details: {
						id: "approval_001",
						action: "write_report",
						targetResource: "reports/schema/report.md",
						status: "pending",
					},
				},
				isError: false,
			},
			ctx,
		);
		expect(statuses.get("metamp-approval")).toBeUndefined();
	});

	it("blocks file mutations outside the Metamp project root", async () => {
		const cwd = await tempRoot();
		const project = await initProject("guard", cwd);
		const api = createRecordingApi();
		await createMetampExtension({ projectRoot: project.root })(api as unknown as ExtensionAPI);
		const handler = api.events.get("tool_call")?.[0];
		expect(handler).toBeDefined();

		const result = await handler?.(
			{
				type: "tool_call",
				toolName: "write",
				toolCallId: "1",
				input: { path: "../escape.txt", content: "bad" },
			} satisfies ToolCallEvent,
			{ cwd: project.root } as unknown as ExtensionContext,
		);

		expect(result).toEqual({ block: true, reason: "Metamp mode blocks file mutations outside the project root." });
	});

	it("allows tracked recipe tools inside recipes", async () => {
		const cwd = await tempRoot();
		const project = await initProject("tools", cwd);
		await writeFile(path.join(project.root, "recipes", "noop.py"), "print('ok')\n", "utf8");
		const api = createRecordingApi();
		await createMetampExtension({ projectRoot: project.root })(api as unknown as ExtensionAPI);

		expect(api.tools).toContain("metamp_run_recipe");
	});
});
