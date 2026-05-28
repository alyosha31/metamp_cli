import path from "node:path";
import type { ExtensionAPI, ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { LocalPythonExecutionBackend } from "./execution/local-python.ts";
import { writeHandoff } from "./handoff/build-handoff.ts";
import { findProjectRoot, isInsidePath, requireProjectRoot } from "./project/paths.ts";
import { formatProjectState, loadProjectState } from "./project/state.ts";
import { promoteRun } from "./runs/run-store.ts";
import { registerMetampTools } from "./tools/metamp-tools.ts";

const METAMP_CONTEXT_HEADER = `You are Metamp, an ML/data-science copilot workbench layered on the Pi harness.

Durable project state lives in .metamp manifests. Treat those manifests as source of truth over chat history. Inspect freely and propose freely, but require user approval before material ML decisions or destructive/expensive actions. Material decisions include target column, problem type, split strategy, metrics, leakage-sensitive columns, row/column dropping rules, expensive training runs, and run promotion. Record decisions before doing dependent work. Use metamp_* tools for project state, recipes, runs, promotion, and handoff.`;

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

async function metampRootFromCwd(cwd: string): Promise<string | undefined> {
	return findProjectRoot(cwd);
}

export function createMetampExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		registerMetampTools(pi);

		pi.on("before_agent_start", async (event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd);
			if (!root) return undefined;
			const state = await loadProjectState(root);
			const pending = state.decisions.decisions.filter((decision) => decision.status === "pending");
			return {
				systemPrompt: `${event.systemPrompt}\n\n${METAMP_CONTEXT_HEADER}\n\nCurrent Metamp project state:\n${formatProjectState(state)}\n\nPending decisions:\n${pending.map((decision) => `- ${decision.id} ${decision.type}: ${JSON.stringify(decision.proposedValue)}`).join("\n") || "none"}`,
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

		pi.on("session_start", async (_event, ctx) => {
			const root = await metampRootFromCwd(ctx.cwd);
			if (!root) return;
			const state = await loadProjectState(root);
			ctx.ui.setTitle(`metamp: ${state.project.name}`);
			ctx.ui.setStatus(
				"metamp",
				`${state.project.name} · ${state.datasets.datasets.length} datasets · ${state.runs.length} runs`,
			);
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
