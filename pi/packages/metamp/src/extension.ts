import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { appendMetampActivity, formatMetampActivity, readRecentMetampActivity } from "./activity/log.ts";
import { readApprovalRequests, recordApprovalRequest } from "./approvals/approval-store.ts";
import { LocalPythonExecutionBackend } from "./execution/local-python.ts";
import { writeHandoff } from "./handoff/build-handoff.ts";
import { assertInsidePathCanonical, findProjectRoot, isInsidePath, requireProjectRoot } from "./project/paths.ts";
import { formatProjectState, loadProjectState } from "./project/state.ts";
import { deriveMetampUiState, nextMetampPlanStep } from "./project/ui-state.ts";
import { promoteRun } from "./runs/run-store.ts";
import { discoverMetampSubagents, findMetampAgentSpec } from "./subagents/discovery.ts";
import {
	applyMetampSubagentProgress,
	createMetampSubagentProgressState,
	type MetampSubagentProgressState,
} from "./subagents/progress.ts";
import { runMetampSubagent } from "./subagents/runner.ts";
import { registerMetampTools } from "./tools/metamp-tools.ts";
import { buildSpecialistCommandList, renderMetampHeaderLines, renderMetampWidgetLines } from "./ui/startup.ts";

const METAMP_CONTEXT_HEADER = `You are Metamp, an ML/data-science copilot workbench layered on the Metamp harness.

Durable project state lives in .metamp manifests. Treat those manifests as source of truth over chat history. Inspect freely and propose freely, but require user approval before material ML decisions or destructive/expensive actions. Material decisions include target column, problem type, split strategy, metrics, leakage-sensitive columns, row/column dropping rules, expensive training runs, and run promotion. Record decisions before doing dependent work. Use metamp_* tools for project state, recipes, runs, promotion, and handoff.`;

export interface CreateMetampExtensionOptions {
	projectRoot?: string;
}

function installMetampHeader(
	ctx: ExtensionContext,
	projectSummary: string | undefined,
	specialistCommands: readonly string[],
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			return renderMetampHeaderLines(theme, width, { projectSummary, specialistCommands });
		},
		invalidate() {},
	}));
	ctx.ui.setWidget(
		"metamp-brand",
		() => ({
			render(width: number): string[] {
				return renderMetampWidgetLines(width, { projectSummary, specialistCommands });
			},
			invalidate() {},
		}),
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

async function commandHasOutsideAbsolutePath(command: string, root: string): Promise<boolean> {
	const absolutePathPattern = /(?:^|\s)(\/[A-Za-z0-9_@%+=:.,~/-]+)/g;
	for (const match of command.matchAll(absolutePathPattern)) {
		const candidate = match[1];
		if (candidate.startsWith("/dev/") || candidate.startsWith("/tmp/") || candidate.startsWith("/var/folders/"))
			continue;
		try {
			await assertInsidePathCanonical(root, path.resolve(candidate), candidate);
		} catch {
			return true;
		}
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

async function metampRootFromCwd(cwd: string, fallbackProjectRoot?: string): Promise<string | undefined> {
	return (await findProjectRoot(cwd)) ?? fallbackProjectRoot;
}

async function loadMetampUi(root: string) {
	const [state, specialistCommands] = await Promise.all([loadProjectState(root), buildSpecialistCommandList(root)]);
	return { state, uiState: deriveMetampUiState(state, specialistCommands) };
}

function clearTransientMetampStatuses(ctx: ExtensionContext): void {
	ctx.ui.setStatus("metamp-run", undefined);
	ctx.ui.setStatus("metamp-approval", undefined);
	ctx.ui.setStatus("metamp-subagent", undefined);
}

async function refreshMetampUi(ctx: ExtensionContext, root: string) {
	const { state, uiState } = await loadMetampUi(root);
	installMetampHeader(ctx, uiState.projectSummary, uiState.specialistCommands);
	if (ctx.hasUI) ctx.ui.setHiddenThinkingLabel("Analyzing Metamp project...");
	ctx.ui.setTitle(`metamp: ${state.project.name}`);
	ctx.ui.setStatus("metamp", uiState.statusLine);
	return { state, uiState };
}
const READ_ONLY_METAMP_TOOLS = new Set([
	"metamp_project_state",
	"metamp_list_subagents",
	"metamp_read_run",
	"metamp_compare_runs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMetampMutatingTool(toolName: string): boolean {
	return toolName.startsWith("metamp_") && !READ_ONLY_METAMP_TOOLS.has(toolName);
}

function resultText(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	const content = result.content;
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
	}
	return undefined;
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!isRecord(result)) return undefined;
	return isRecord(result.details) ? result.details : undefined;
}

function toolStatusText(toolName: string, value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	switch (toolName) {
		case "metamp_run_recipe":
			return typeof value.path === "string" ? `run ${value.path}` : "run recipe";
		case "metamp_promote_run":
			return typeof value.runId === "string" ? `promote ${value.runId}` : "promote run";
		case "metamp_subagent":
			if (isRecord(value.progress)) {
				const progress = value.progress;
				const status = typeof progress.status === "string" ? progress.status : "subagent running";
				const currentTool = typeof progress.currentTool === "string" ? ` · ${progress.currentTool}` : "";
				return `${status}${currentTool}`;
			}
			if (typeof value.agent === "string" && typeof value.task === "string") return `${value.agent}: ${value.task}`;
			return typeof value.agent === "string" ? `${value.agent} running` : "subagent running";
		case "metamp_request_cross_scope_change":
			return typeof value.targetResource === "string" ? `approval ${value.targetResource}` : "approval requested";
		case "metamp_propose_decision":
			return typeof value.type === "string" ? `decision ${value.type}` : "decision proposed";
		case "metamp_record_decision":
			return typeof value.id === "string" ? `decision ${value.id}` : "decision recorded";
		default:
			return undefined;
	}
}

function toolStatusKey(toolName: string): string | undefined {
	switch (toolName) {
		case "metamp_run_recipe":
		case "metamp_promote_run":
			return "metamp-run";
		case "metamp_subagent":
			return "metamp-subagent";
		case "metamp_request_cross_scope_change":
			return "metamp-approval";
		default:
			return undefined;
	}
}

function isRunDetails(details: Record<string, unknown> | undefined): details is Record<string, string> {
	return !!details && typeof details.runId === "string" && typeof details.status === "string";
}

function isDecisionDetails(details: Record<string, unknown> | undefined): details is Record<string, string> {
	return (
		!!details &&
		typeof details.id === "string" &&
		typeof details.type === "string" &&
		typeof details.status === "string"
	);
}

function isApprovalDetails(details: Record<string, unknown> | undefined): details is Record<string, string> {
	return (
		!!details &&
		typeof details.id === "string" &&
		typeof details.action === "string" &&
		typeof details.targetResource === "string" &&
		typeof details.status === "string"
	);
}

async function safeAppendActivity(root: string, event: Parameters<typeof appendMetampActivity>[1]): Promise<void> {
	try {
		await appendMetampActivity(root, event);
	} catch {}
}

async function logMetampToolStart(root: string, toolName: string, args: unknown): Promise<void> {
	switch (toolName) {
		case "metamp_run_recipe":
			await safeAppendActivity(root, {
				timestamp: new Date().toISOString(),
				kind: "run",
				subjectId: toolStatusText(toolName, args) ?? toolName,
				status: "started",
				message: toolStatusText(toolName, args) ?? "run started",
				metadata: isRecord(args) ? args : undefined,
			});
			return;
		case "metamp_promote_run":
			await safeAppendActivity(root, {
				timestamp: new Date().toISOString(),
				kind: "promotion",
				subjectId: toolStatusText(toolName, args) ?? toolName,
				status: "started",
				message: toolStatusText(toolName, args) ?? "promotion started",
				metadata: isRecord(args) ? args : undefined,
			});
			return;
		case "metamp_subagent": {
			const subagentName = isRecord(args) && typeof args.agent === "string" ? args.agent : "subagent";
			const taskPreview = isRecord(args) && typeof args.task === "string" ? args.task.slice(0, 120) : undefined;
			await safeAppendActivity(root, {
				timestamp: new Date().toISOString(),
				kind: "subagent",
				subjectId: subagentName,
				status: "started",
				message: toolStatusText(toolName, args) ?? `${subagentName} started`,
				metadata: { taskPreview },
			});
			return;
		}
		case "metamp_propose_decision":
		case "metamp_record_decision":
			await safeAppendActivity(root, {
				timestamp: new Date().toISOString(),
				kind: "decision",
				subjectId: toolStatusText(toolName, args) ?? toolName,
				status: "started",
				message: toolStatusText(toolName, args) ?? "decision updated",
				metadata: isRecord(args) ? args : undefined,
			});
			return;
		case "metamp_request_cross_scope_change":
			await safeAppendActivity(root, {
				timestamp: new Date().toISOString(),
				kind: "approval",
				subjectId: toolStatusText(toolName, args) ?? toolName,
				status: "started",
				message: toolStatusText(toolName, args) ?? "approval requested",
				metadata: isRecord(args) ? args : undefined,
			});
			return;
		default:
			return;
	}
}

async function logMetampToolEnd(
	root: string,
	toolName: string,
	args: unknown,
	result: unknown,
	isError: boolean,
): Promise<void> {
	const timestamp = new Date().toISOString();
	const details = resultDetails(result);
	const message = resultText(result) ?? toolStatusText(toolName, args) ?? toolName;
	if (toolName === "metamp_promote_run") {
		await safeAppendActivity(root, {
			timestamp,
			kind: "promotion",
			subjectId: (isRecord(args) && typeof args.runId === "string" ? args.runId : toolName) as string,
			status: isError ? "failed" : "promoted",
			message,
			metadata: details,
		});
		return;
	}
	if (toolName === "metamp_run_recipe") {
		await safeAppendActivity(root, {
			timestamp,
			kind: "run",
			subjectId: isRunDetails(details) ? details.runId : (toolStatusText(toolName, args) ?? toolName),
			status: isError ? "failed" : isRunDetails(details) ? details.status : "completed",
			message,
			metadata: details,
		});
		return;
	}
	if (toolName === "metamp_subagent") {
		const subagentName = isRecord(args) && typeof args.agent === "string" ? args.agent : "subagent";
		const taskPreview = isRecord(args) && typeof args.task === "string" ? args.task.slice(0, 120) : undefined;
		const exitCode = isRecord(details) && typeof details.exitCode === "number" ? details.exitCode : undefined;
		const outputBytes =
			isRecord(details) && typeof details.output === "string"
				? Buffer.byteLength(details.output, "utf8")
				: undefined;
		await safeAppendActivity(root, {
			timestamp,
			kind: "subagent",
			subjectId: subagentName,
			status: isError ? "failed" : exitCode === 0 ? "completed" : exitCode === 130 ? "aborted" : "failed",
			message,
			metadata: { exitCode, outputBytes, taskPreview },
		});
		return;
	}
	if (isDecisionDetails(details)) {
		await safeAppendActivity(root, {
			timestamp,
			kind: "decision",
			subjectId: details.id,
			status: isError ? "failed" : details.status,
			message,
			metadata: details,
		});
		return;
	}
	if (isApprovalDetails(details)) {
		await safeAppendActivity(root, {
			timestamp,
			kind: "approval",
			subjectId: details.id,
			status: isError ? "failed" : details.status,
			message,
			metadata: details,
		});
	}
}
function compactProgressText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, width: number): string {
	if (width <= 1) return "";
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function renderSubagentProgressOverlay(
	state: MetampSubagentProgressState,
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
	];
	if (state.currentTool) lines.push(line(theme.fg("dim", `tool: ${state.currentTool}`)));
	if (state.recentTools.length > 0) lines.push(line(theme.fg("dim", `recent tools: ${state.recentTools.join(", ")}`)));
	lines.push(section("thought process"));
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
	const state = createMetampSubagentProgressState(input.agentName, input.task);
	let requestRender: (() => void) | undefined;
	let renderTimer: NodeJS.Timeout | undefined;
	const scheduleRender = (immediate = false) => {
		if (!requestRender) return;
		if (renderTimer) {
			clearTimeout(renderTimer);
			renderTimer = undefined;
		}
		if (immediate) {
			requestRender();
			return;
		}
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			requestRender?.();
		}, 120);
		renderTimer.unref?.();
	};
	const modelOptions = await subagentModelOptions(ctx);
	const runPromise = runMetampSubagent({
		projectRoot: input.projectRoot,
		agentName: input.agentName,
		task: input.task,
		signal: ctx.signal,
		...modelOptions,
		allowProjectLocalAgent: input.allowProjectLocalAgent,
		onProgress(event) {
			applyMetampSubagentProgress(state, event);
			scheduleRender(event.type !== "thinking" && event.type !== "text");
		},
	});
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			requestRender = () => tui.requestRender();
			runPromise.finally(() => {
				scheduleRender(true);
				done();
			});
			return {
				render(width: number): string[] {
					return renderSubagentProgressOverlay(state, width, theme);
				},
				invalidate() {},
				dispose() {
					if (renderTimer) clearTimeout(renderTimer);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "85%", maxHeight: "60%", anchor: "center", nonCapturing: true },
		},
	);
	return runPromise;
}

export function createMetampExtension(options: CreateMetampExtensionOptions = {}): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		registerMetampTools(pi);
		const startupProjectRoot = options.projectRoot ?? (await findProjectRoot(process.cwd()));
		const startupAgents = await discoverMetampSubagents(
			startupProjectRoot ? { projectRoot: startupProjectRoot } : {},
		);
		const activeToolArgs = new Map<string, unknown>();
		pi.on("before_agent_start", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root) return undefined;
			const state = await loadProjectState(root);
			const pending = state.decisions.decisions.filter((decision) => decision.status === "pending");
			const pendingApprovals = state.approvals.approvals.filter((approval) => approval.status === "pending");
			return {
				systemPrompt: `${event.systemPrompt}\n\n${METAMP_CONTEXT_HEADER}\n\nCurrent Metamp project state:\n${formatProjectState(state)}\n\nPending decisions:\n${pending.map((decision) => `- ${decision.id} ${decision.type}: ${JSON.stringify(decision.proposedValue)}`).join("\n") || "none"}\n\nPending approvals:\n${pendingApprovals.map((approval) => `- ${approval.id} ${approval.action} ${approval.targetResource}`).join("\n") || "none"}`,
			};
		});

		pi.on("tool_call", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root) return undefined;
			const targetPath = eventPath(event);
			if (targetPath) {
				const absolute = path.resolve(ctx.cwd, targetPath);
				if (!isInsidePath(root, absolute)) {
					return { block: true, reason: "Metamp mode blocks file mutations outside the project root." };
				}
				try {
					await assertInsidePathCanonical(root, absolute, targetPath);
				} catch {
					return { block: true, reason: "Metamp mode blocks file mutations outside the project root." };
				}
			}
			const command = eventCommand(event);
			if (command && (await commandHasOutsideAbsolutePath(command, root))) {
				return {
					block: true,
					reason: "Metamp mode blocks bash commands that reference absolute paths outside the project root.",
				};
			}
			return undefined;
		});

		pi.on("session_start", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root) return;
			const { uiState } = await refreshMetampUi(ctx, root);
			clearTransientMetampStatuses(ctx);
			if (event.reason === "startup") ctx.ui.notify(`Metamp status\n${uiState.statusText}`, "info");
		});

		pi.on("turn_start", async (_event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root) return;
			const { uiState } = await loadMetampUi(root);
			ctx.ui.setWorkingMessage("Metamp thinking");
			ctx.ui.setStatus("metamp", `${uiState.projectSummary} · thinking`);
		});

		pi.on("thinking_level_select", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root) return;
			const { uiState } = await loadMetampUi(root);
			ctx.ui.setStatus("metamp", `${uiState.projectSummary} · thinking ${event.level}`);
		});

		pi.on("tool_execution_start", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root || !event.toolName.startsWith("metamp_")) return;
			activeToolArgs.set(event.toolCallId, event.args);
			const statusKey = toolStatusKey(event.toolName);
			const statusText = toolStatusText(event.toolName, event.args);
			if (statusKey && statusText) ctx.ui.setStatus(statusKey, statusText);
			await logMetampToolStart(root, event.toolName, event.args);
		});

		pi.on("tool_execution_update", async (event, ctx) => {
			const statusKey = toolStatusKey(event.toolName);
			const statusText = toolStatusText(event.toolName, resultDetails(event.partialResult) ?? event.partialResult);
			if (statusKey && statusText) ctx.ui.setStatus(statusKey, statusText);
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			const toolArgs = activeToolArgs.get(event.toolCallId);
			activeToolArgs.delete(event.toolCallId);
			if (!root || !event.toolName.startsWith("metamp_")) return;
			await logMetampToolEnd(root, event.toolName, toolArgs, event.result, event.isError);
			const statusKey = toolStatusKey(event.toolName);
			if (statusKey) ctx.ui.setStatus(statusKey, undefined);
			if (isMetampMutatingTool(event.toolName)) await refreshMetampUi(ctx, root);
		});

		pi.on("turn_end", async (_event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			ctx.ui.setWorkingMessage();
			clearTransientMetampStatuses(ctx);
			if (!root) return;
			await refreshMetampUi(ctx, root);
		});

		pi.on("session_before_tree", async (_event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd, startupProjectRoot);
			if (!root) return undefined;
			const { uiState } = await loadMetampUi(root);
			return {
				summary: {
					summary: `Metamp ${uiState.projectSummary}, promoted ${uiState.promotedRunSummary}`,
				},
				label: `metamp:${uiState.projectSummary.split(" · ")[0]}`,
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
					await safeAppendActivity(root, {
						timestamp: new Date().toISOString(),
						kind: "subagent",
						subjectId: agentName,
						status: "started",
						message: `${agentName}: ${task}`,
						metadata: { taskPreview: task.slice(0, 120) },
					});
					ctx.ui.setStatus("metamp-subagent", `${agentName} running`);
					ctx.ui.notify(`${agentName} running: ${task}`, "info");
					try {
						const result = await runSubagentWithProgressOverlay(ctx, {
							projectRoot: root,
							agentName,
							task,
							allowProjectLocalAgent,
						});
						await safeAppendActivity(root, {
							timestamp: new Date().toISOString(),
							kind: "subagent",
							subjectId: agentName,
							status: result.exitCode === 0 ? "completed" : result.exitCode === 130 ? "aborted" : "failed",
							message: result.stderr || result.output || `${agentName} finished`,
							metadata: {
								exitCode: result.exitCode,
								outputBytes: Buffer.byteLength(result.output, "utf8"),
								taskPreview: task.slice(0, 120),
							},
						});
						if (result.exitCode === 0) {
							await ctx.ui.editor(`${agentName} result`, result.output || "(no output)");
						} else {
							ctx.ui.notify(result.stderr || result.output || `${agentName} failed`, "error");
						}
					} finally {
						ctx.ui.setStatus("metamp-subagent", undefined);
						await refreshMetampUi(ctx, root);
					}
				},
			});
		};
		for (const agent of startupAgents) {
			registerSubagentCommand(agent.name, agent.name, agent.description);
		}
		pi.registerCommand("metamp-status", {
			description: "Show Metamp project state",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const { uiState } = await loadMetampUi(root);
				ctx.ui.notify(`Metamp status\n${uiState.statusText}`, "info");
			},
		});

		pi.registerCommand("metamp-log", {
			description: "Show recent durable Metamp activity",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				ctx.ui.notify(formatMetampActivity(await readRecentMetampActivity(root, 20)), "info");
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
				await safeAppendActivity(root, {
					timestamp: new Date().toISOString(),
					kind: "run",
					subjectId: recipe,
					status: "started",
					message: `run ${recipe}`,
					metadata: { recipePath: recipe },
				});
				const result = await new LocalPythonExecutionBackend().runRecipe(
					{ projectRoot: root, recipePath: recipe },
					ctx.signal,
				);
				await safeAppendActivity(root, {
					timestamp: new Date().toISOString(),
					kind: "run",
					subjectId: result.manifest.runId,
					status: result.manifest.status,
					message: `${result.manifest.runId}: ${result.manifest.status}`,
					metadata: { runId: result.manifest.runId, recipePath: result.manifest.recipePath },
				});
				await refreshMetampUi(ctx, root);
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
				await safeAppendActivity(root, {
					timestamp: new Date().toISOString(),
					kind: "promotion",
					subjectId: runId,
					status: "started",
					message: `promote ${runId}`,
				});
				await promoteRun(root, runId);
				await safeAppendActivity(root, {
					timestamp: new Date().toISOString(),
					kind: "promotion",
					subjectId: runId,
					status: "promoted",
					message: `Promoted ${runId}`,
				});
				await refreshMetampUi(ctx, root);
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

		pi.registerCommand("metamp-approvals", {
			description: "List pending Metamp approvals",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const approvals = (await readApprovalRequests(root)).approvals.filter(
					(approval) => approval.status === "pending",
				);
				ctx.ui.notify(
					approvals.map((approval) => `${approval.id} ${approval.action} ${approval.targetResource}`).join("\n") ||
						"No pending approvals",
					"info",
				);
			},
		});

		pi.registerCommand("metamp-approval", {
			description: "Record a Metamp approval decision",
			handler: async (args, ctx) => {
				const [id, status] = args.trim().split(/\s+/, 2);
				if (!id || !status) {
					ctx.ui.notify("Usage: /metamp-approval <id> <approved|rejected|superseded>", "error");
					return;
				}
				if (!["approved", "rejected", "superseded"].includes(status)) {
					ctx.ui.notify("Approval status must be approved, rejected, or superseded", "error");
					return;
				}
				const confirmed = await ctx.ui.confirm("Record approval", `${status} approval ${id}?`);
				if (!confirmed) return;
				const root = await requireProjectRoot(ctx.cwd);
				const approval = await recordApprovalRequest(root, {
					id,
					status: status as "approved" | "rejected" | "superseded",
				});
				await safeAppendActivity(root, {
					timestamp: new Date().toISOString(),
					kind: "approval",
					subjectId: approval.id,
					status: approval.status,
					message: `${approval.id}: ${approval.status}`,
					metadata: { action: approval.action, targetResource: approval.targetResource },
				});
				await refreshMetampUi(ctx, root);
				ctx.ui.notify(`Recorded ${approval.id}: ${approval.status}`, "info");
			},
		});

		pi.registerCommand("metamp-plan", {
			description: "Show a manifest-grounded ML workflow plan",
			handler: async (_args, ctx) => {
				const root = await requireProjectRoot(ctx.cwd);
				const { state, uiState } = await loadMetampUi(root);
				ctx.ui.notify(`${uiState.statusText}\n\nNext: ${nextMetampPlanStep(state)}`, "info");
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
