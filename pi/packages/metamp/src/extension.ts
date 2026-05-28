import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { LocalPythonExecutionBackend } from "./execution/local-python.ts";
import { writeHandoff } from "./handoff/build-handoff.ts";
import { findProjectRoot, isInsidePath, requireProjectRoot } from "./project/paths.ts";
import { formatProjectState, loadProjectState } from "./project/state.ts";
import { promoteRun } from "./runs/run-store.ts";
import { discoverMetampSubagents, findMetampAgentSpec } from "./subagents/discovery.ts";
import { type MetampSubagentProgressEvent, runMetampSubagent } from "./subagents/runner.ts";
import { registerMetampTools } from "./tools/metamp-tools.ts";

const METAMP_CONTEXT_HEADER = `You are Metamp, an ML/data-science copilot workbench layered on the Metamp harness.

Durable project state lives in .metamp manifests. Treat those manifests as source of truth over chat history. Inspect freely and propose freely, but require user approval before material ML decisions or destructive/expensive actions. Material decisions include target column, problem type, split strategy, metrics, leakage-sensitive columns, row/column dropping rules, expensive training runs, and run promotion. Record decisions before doing dependent work. Use metamp_* tools for project state, recipes, runs, promotion, and handoff.`;

interface SubagentProgressState {
	agentName: string;
	task: string;
	status: string;
	thinking: string;
	drafting: string;
	activity: string[];
}

function installMetampHeader(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setHeader((_tui, theme) => ({
		render(_width: number): string[] {
			const accent = (text: string) => theme.bold(theme.fg("accent", text));
			const muted = (text: string) => theme.fg("muted", text);
			const dim = (text: string) => theme.fg("dim", text);
			return [
				"",
				accent("▗▖  ▗▖ ▗▄▄▄▖▗▄▄▄▖ ▗▄▖ ▗▖  ▗▖▗▄▄▖"),
				accent("▐▛▚▞▜▌ ▐▌    █  ▐▌ ▐▌▐▛▚▞▜▌▐▌ ▐▌"),
				accent("▐▌  ▐▌ ▐▛▀   █  ▐▛▀▜▌▐▌  ▐▌▐▛▀▘"),
				accent("▐▌  ▐▌ ▐▙▄▄▖ █  ▐▌ ▐▌▐▌  ▐▌▐▌"),
				`${accent("metamp")} ${muted("ML copilot workbench")}`,
				dim("escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more"),
				dim("specialists: /data-profiler · /schema-detective · /quality-auditor · /leakage-auditor"),
				"",
			];
		},
		invalidate() {},
	}));
	ctx.ui.setWidget(
		"metamp-brand",
		["metamp · ML copilot workbench", "specialists: /data-profiler · /schema-detective · /leakage-auditor"],
		{ placement: "aboveEditor" },
	);
}

function eventPath(event: ToolCallEvent): string | undefined {
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const input = event.input as { path?: unknown };
	return typeof input.path === "string" ? input.path : undefined;
}

function eventCommand(event: ToolCallEvent): string | undefined {
	if (event.toolName !== "bash") return undefined;
	const input = event.input as { command?: unknown };
	return typeof input.command === "string" ? input.command : undefined;
}

function commandHasOutsideAbsolutePath(command: string, root: string): boolean {
	const absolutePathPattern = /(?:^|\s)(\/[A-Za-z0-9_@%+=:.,~/-]+)/g;
	for (const match of command.matchAll(absolutePathPattern)) {
		const candidate = match[1];
		if (candidate.startsWith("/dev/") || candidate.startsWith("/tmp/") || candidate.startsWith("/var/folders/"))
			continue;
		if (!isInsidePath(root, path.resolve(candidate))) return true;
	}
	return false;
}

async function subagentModelOptions(ctx: ExtensionContext): Promise<{ model?: string; apiKey?: string }> {
	if (!ctx.model) return {};
	return {
		model: `${ctx.model.provider}/${ctx.model.id}`,
		apiKey: await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider),
	};
}

async function metampRootFromCwd(cwd: string): Promise<string | undefined> {
	return findProjectRoot(cwd);
}

function compactProgressText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, width: number): string {
	if (width <= 1) return "";
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function appendActivity(state: SubagentProgressState, line: string): void {
	const compact = compactProgressText(line);
	if (!compact || state.activity.at(-1) === compact) return;
	state.activity.push(compact);
	while (state.activity.length > 6) state.activity.shift();
}

function createSubagentProgressState(agentName: string, task: string): SubagentProgressState {
	return { agentName, task, status: "starting", thinking: "", drafting: "", activity: [] };
}

function applySubagentProgress(state: SubagentProgressState, event: MetampSubagentProgressEvent): void {
	if (event.type === "thinking") {
		state.status = "thinking";
		state.thinking = `${state.thinking}${event.text}`.slice(-500);
		return;
	}
	if (event.type === "text") {
		state.status = "drafting";
		state.drafting = `${state.drafting}${event.text}`.slice(-500);
		return;
	}
	state.status = event.type === "error" ? "error" : event.type;
	appendActivity(state, event.text);
}

function renderSubagentProgressOverlay(
	state: SubagentProgressState,
	width: number,
	theme: { bold(text: string): string; fg(color: string, text: string): string },
): string[] {
	const boxWidth = Math.max(48, Math.min(width - 4, 100));
	const inner = boxWidth - 4;
	const border = theme.fg("borderMuted", "─".repeat(Math.max(0, boxWidth - 2)));
	const line = (text = "") =>
		`${theme.fg("borderMuted", "│")} ${clipText(text, inner).padEnd(inner)} ${theme.fg("borderMuted", "│")}`;
	const section = (label: string) => line(theme.fg("muted", label));
	const lines = [
		`${theme.fg("borderMuted", "┌")}${border}${theme.fg("borderMuted", "┐")}`,
		line(`${theme.bold(theme.fg("accent", state.agentName))} ${theme.fg("dim", state.status)}`),
		line(theme.fg("dim", `task: ${state.task}`)),
		section("thought process"),
	];
	const thinking = compactProgressText(state.thinking);
	lines.push(
		line(thinking ? `thinking: ${thinking}` : theme.fg("dim", "thinking: waiting for model reasoning events")),
	);
	const drafting = compactProgressText(state.drafting);
	if (drafting) lines.push(line(`drafting: ${drafting}`));
	lines.push(section("activity"));
	if (state.activity.length === 0) lines.push(line(theme.fg("dim", "no events yet")));
	else for (const item of state.activity) lines.push(line(item));
	lines.push(`${theme.fg("borderMuted", "└")}${border}${theme.fg("borderMuted", "┘")}`);
	return lines;
}

async function runSubagentWithProgressOverlay(
	ctx: ExtensionContext,
	input: {
		projectRoot: string;
		agentName: string;
		task: string;
		allowProjectLocalAgent: boolean;
	},
) {
	const state = createSubagentProgressState(input.agentName, input.task);
	let requestRender: (() => void) | undefined;
	const modelOptions = await subagentModelOptions(ctx);
	const runPromise = runMetampSubagent({
		projectRoot: input.projectRoot,
		agentName: input.agentName,
		task: input.task,
		signal: ctx.signal,
		...modelOptions,
		allowProjectLocalAgent: input.allowProjectLocalAgent,
		onProgress(event) {
			applySubagentProgress(state, event);
			requestRender?.();
		},
	});
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			requestRender = () => tui.requestRender();
			runPromise.finally(() => done());
			return {
				render(width: number): string[] {
					return renderSubagentProgressOverlay(state, width, theme);
				},
				invalidate() {},
				dispose() {},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "85%", maxHeight: "60%", anchor: "center", nonCapturing: true },
		},
	);
	return runPromise;
}

export function createMetampExtension(): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		registerMetampTools(pi);

		pi.on("before_agent_start", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd);
			if (!root) return undefined;
			const state = await loadProjectState(root);
			const pending = state.decisions.decisions.filter((decision) => decision.status === "pending");
			const pendingApprovals = state.approvals.approvals.filter((approval) => approval.status === "pending");
			return {
				systemPrompt: `${event.systemPrompt}\n\n${METAMP_CONTEXT_HEADER}\n\nCurrent Metamp project state:\n${formatProjectState(state)}\n\nPending decisions:\n${pending.map((decision) => `- ${decision.id} ${decision.type}: ${JSON.stringify(decision.proposedValue)}`).join("\n") || "none"}\n\nPending approvals:\n${pendingApprovals.map((approval) => `- ${approval.id} ${approval.action} ${approval.targetResource}`).join("\n") || "none"}`,
			};
		});

		pi.on("tool_call", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd);
			if (!root) return undefined;
			const targetPath = eventPath(event);
			if (targetPath) {
				const absolute = path.resolve(ctx.cwd, targetPath);
				if (!isInsidePath(root, absolute)) {
					return { block: true, reason: "Metamp mode blocks file mutations outside the project root." };
				}
			}
			const command = eventCommand(event);
			if (command && commandHasOutsideAbsolutePath(command, root)) {
				return {
					block: true,
					reason: "Metamp mode blocks bash commands that reference absolute paths outside the project root.",
				};
			}
			return undefined;
		});

		pi.on("session_start", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd);
			if (!root) return;
			const state = await loadProjectState(root);
			installMetampHeader(ctx);
			ctx.ui.setTitle(`metamp: ${state.project.name}`);
			ctx.ui.setStatus(
				"metamp",
				`${state.project.name} · ${state.datasets.datasets.length} datasets · ${state.runs.length} runs`,
			);
			if (event.reason === "startup") ctx.ui.notify(`Metamp status\n${formatProjectState(state)}`, "info");
		});

		pi.on("session_before_tree", async (_event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd);
			if (!root) return undefined;
			const state = await loadProjectState(root);
			return {
				summary: {
					summary: `Metamp ${state.project.name}: ${state.datasets.datasets.length} datasets, ${state.runs.length} runs, promoted ${state.project.promotedRunId ?? "none"}`,
				},
				label: `metamp:${state.project.name}`,
			};
		});

		const registerSubagentCommand = (commandName: string, agentName: string, description: string) => {
			pi.registerCommand(commandName, {
				description,
				handler: async (args, ctx) => {
					const task = args.trim();
					if (!task) {
						ctx.ui.notify(`Usage: /${commandName} <task>`, "error");
						return;
					}
					const root = await requireProjectRoot(ctx.cwd);
					const resolvedAgent = await findMetampAgentSpec(agentName, { projectRoot: root });
					let allowProjectLocalAgent = false;
					if (resolvedAgent?.requiresConfirmation) {
						const confirmed = await ctx.ui.confirm(
							"Run project-local Metamp subagent",
							`Run ${resolvedAgent.name} from ${resolvedAgent.definitionPath ?? "project configuration"}?`,
						);
						if (!confirmed) return;
						allowProjectLocalAgent = true;
					}
					const runningText = `${agentName} running: ${task}`;
					ctx.ui.setStatus("metamp-subagent", `${agentName} running`);
					ctx.ui.notify(runningText, "info");
					try {
						const result = await runSubagentWithProgressOverlay(ctx, {
							projectRoot: root,
							agentName,
							task,
							allowProjectLocalAgent,
						});
						if (result.exitCode === 0) {
							const output = result.output || "(no output)";
							await ctx.ui.editor(`${agentName} result`, output);
						} else {
							ctx.ui.notify(result.stderr || result.output || `${agentName} failed`, "error");
						}
					} finally {
						ctx.ui.setStatus("metamp-subagent", undefined);
					}
				},
			});
		};

		for (const agent of await discoverMetampSubagents()) {
			registerSubagentCommand(agent.name, agent.name, agent.description);
		}
		pi.registerCommand("metamp-status", {
			description: "Show Metamp project state",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				ctx.ui.notify(formatProjectState(await loadProjectState(root)), "info");
			},
		});

		pi.registerCommand("metamp-runs", {
			description: "Show Metamp runs",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const state = await loadProjectState(root);
				ctx.ui.notify(
					state.runs
						.map((run) => `${run.runId} ${run.status} ${run.recipePath} metrics=${JSON.stringify(run.metrics)}`)
						.join("\n") || "No runs",
					"info",
				);
			},
		});

		pi.registerCommand("metamp-run", {
			description: "Run a Metamp recipe",
			handler: async (args, ctx) => {
				const recipe = args.trim();
				if (!recipe) {
					ctx.ui.notify("Usage: /metamp-run <recipes/file.py>", "error");
					return;
				}
				const root = await requireProjectRoot(ctx.cwd);
				const result = await new LocalPythonExecutionBackend().runRecipe(
					{ projectRoot: root, recipePath: recipe },
					ctx.signal,
				);
				ctx.ui.notify(
					`${result.manifest.runId}: ${result.manifest.status}`,
					result.manifest.status === "succeeded" ? "info" : "error",
				);
			},
		});

		pi.registerCommand("metamp-promote", {
			description: "Promote a successful Metamp run",
			handler: async (args, ctx) => {
				const runId = args.trim();
				if (!runId) {
					ctx.ui.notify("Usage: /metamp-promote <run-id>", "error");
					return;
				}
				const confirmed = await ctx.ui.confirm("Promote run", `Promote ${runId} as final?`);
				if (!confirmed) return;
				const root = await requireProjectRoot(ctx.cwd);
				await promoteRun(root, runId);
				ctx.ui.notify(`Promoted ${runId}`, "info");
			},
		});

		pi.registerCommand("metamp-decision", {
			description: "List pending Metamp decisions",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const state = await loadProjectState(root);
				const pending = state.decisions.decisions.filter((decision) => decision.status === "pending");
				ctx.ui.notify(
					pending
						.map((decision) => `${decision.id} ${decision.type}: ${JSON.stringify(decision.proposedValue)}`)
						.join("\n") || "No pending decisions",
					"info",
				);
			},
		});

		pi.registerCommand("metamp-plan", {
			description: "Show a manifest-grounded ML workflow plan",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const state = await loadProjectState(root);
				const next = state.project.activeTargetColumn
					? "Run or compare recipes against the approved metric."
					: "Approve a target column and problem type before training.";
				ctx.ui.notify(`${formatProjectState(state)}\n\nNext: ${next}`, "info");
			},
		});

		pi.registerCommand("metamp-handoff", {
			description: "Create a Metamp handoff and start a new session",
			handler: async (args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const handoff = await writeHandoff(root, { goal: args.trim() || undefined });
				const currentSessionFile = ctx.sessionManager.getSessionFile();
				await ctx.newSession({
					parentSession: currentSessionFile,
					withSession: async (replacementCtx) => {
						replacementCtx.ui.setEditorText(handoff.content);
						replacementCtx.ui.notify(`Handoff ready from ${handoff.path}`, "info");
					},
				});
			},
		});

		pi.registerCommand("metamp-fork", {
			description: "Fork the session with Metamp project state preserved",
			handler: async (_args, ctx) => {
				const branch = ctx.sessionManager.getBranch();
				const leaf = branch.at(-1);
				if (!leaf) {
					ctx.ui.notify("No session entries to fork", "error");
					return;
				}
				await ctx.fork(leaf.id, {
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify("Metamp fork ready. Durable project state remains in .metamp.", "info");
					},
				});
			},
		});
	};
}

export default createMetampExtension();
