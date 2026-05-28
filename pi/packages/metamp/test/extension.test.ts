import { mkdtemp, writeFile } from "node:fs/promises";
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
				"metamp-plan",
				"metamp-decision",
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

	it("injects manifest-grounded context before agent starts", async () => {
		const cwd = await tempRoot();
		const project = await initProject("context", cwd);
		const api = createRecordingApi();
		await createMetampExtension()(api as unknown as ExtensionAPI);
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
		const api = createRecordingApi();
		await createMetampExtension()(api as unknown as ExtensionAPI);
		const handler = api.events.get("session_start")?.[0];
		let headerFactory: unknown;
		const notifications: string[] = [];
		const widgets: string[][] = [];
		expect(handler).toBeDefined();

		await handler?.({ reason: "startup" }, {
			cwd: project.root,
			hasUI: true,
			ui: {
				setHeader(factory: unknown) {
					headerFactory = factory;
				},
				setWidget(_key: string, content: string[] | undefined) {
					if (content) widgets.push(content);
				},
				setTitle() {},
				setStatus() {},
				notify(message: string) {
					notifications.push(message);
				},
			},
		} as unknown as ExtensionContext);
		const rendered =
			typeof headerFactory === "function"
				? headerFactory({}, { bold: (text: string) => text, fg: (_color: string, text: string) => text }).render(80)
				: [];

		expect(rendered.join("\n")).toContain("metamp");
		expect(rendered.join("\n")).toContain("/data-profiler");
		expect(widgets.flat().join("\n")).toContain("metamp");
		expect(widgets.flat().join("\n")).toContain("/schema-detective");
		expect(notifications).toEqual([expect.stringContaining("Metamp status")]);
		expect(notifications[0]).toContain("Project: header");
	});

	it("blocks file mutations outside the Metamp project root", async () => {
		const cwd = await tempRoot();
		const project = await initProject("guard", cwd);
		const api = createRecordingApi();
		await createMetampExtension()(api as unknown as ExtensionAPI);
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
		await createMetampExtension()(api as unknown as ExtensionAPI);

		expect(api.tools).toContain("metamp_run_recipe");
	});
});
