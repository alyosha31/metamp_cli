import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { proposeDecision, recordDecision } from "../decisions/decision-store.ts";
import { LocalPythonExecutionBackend } from "../execution/local-python.ts";
import { writeHandoff } from "../handoff/build-handoff.ts";
import { writeYamlFile } from "../manifests/io.ts";
import type { DecisionStatus, DecisionType } from "../manifests/schema.ts";
import { registerDataset } from "../project/datasets.ts";
import { assertProjectRelativeUnder, requireProjectRoot, toProjectRelative } from "../project/paths.ts";
import { formatProjectState, loadProjectState } from "../project/state.ts";
import { promoteRun, readRun } from "../runs/run-store.ts";

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

async function rootFromCtx(ctx: ExtensionContext): Promise<string> {
	return requireProjectRoot(ctx.cwd);
}

const decisionTypes = [
	"target",
	"problem_type",
	"split",
	"metric",
	"cleaning",
	"leakage",
	"promotion",
	"custom",
] as const;
const decisionStatuses = ["pending", "approved", "rejected", "superseded"] as const;

export function registerMetampTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "metamp_project_state",
		label: "Metamp State",
		description: "Read current Metamp project, dataset, decision, and run manifests.",
		promptSnippet: "Use metamp_project_state to ground ML decisions in durable .metamp manifests.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const state = await loadProjectState(root);
			return textResult(formatProjectState(state), state);
		},
	});

	pi.registerTool({
		name: "metamp_register_dataset",
		label: "Register Dataset",
		description: "Register a dataset in .metamp/datasets.yaml after validating the path and hashing content.",
		parameters: Type.Object({
			path: Type.String(),
			mode: Type.Optional(Type.Union([Type.Literal("copy"), Type.Literal("link")])),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const result = await registerDataset(root, params.path, { mode: params.mode ?? "copy" });
			return textResult(`Registered ${result.dataset.id}: ${result.dataset.storedPath}`, result);
		},
	});

	pi.registerTool({
		name: "metamp_propose_decision",
		label: "Propose Decision",
		description: "Persist a pending material ML decision before asking the user for approval.",
		parameters: Type.Object({
			type: Type.Union(decisionTypes.map((type) => Type.Literal(type))),
			proposedValue: Type.Unknown(),
			rationale: Type.Optional(Type.String()),
			sourceRunId: Type.Optional(Type.String()),
			sourceArtifactPath: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const decision = await proposeDecision(root, {
				type: params.type as DecisionType,
				proposedValue: params.proposedValue,
				rationale: params.rationale,
				sourceRunId: params.sourceRunId,
				sourceArtifactPath: params.sourceArtifactPath,
			});
			return textResult(
				`Pending decision ${decision.id}: ${decision.type} = ${JSON.stringify(decision.proposedValue)}. Ask the user to approve, reject, or inspect evidence before proceeding.`,
				decision,
			);
		},
	});

	pi.registerTool({
		name: "metamp_record_decision",
		label: "Record Decision",
		description: "Record an approved, rejected, or superseded material ML decision.",
		parameters: Type.Object({
			id: Type.String(),
			status: Type.Union(decisionStatuses.map((status) => Type.Literal(status))),
			approvedValue: Type.Optional(Type.Unknown()),
			rationale: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const decision = await recordDecision(root, {
				id: params.id,
				status: params.status as DecisionStatus,
				approvedValue: params.approvedValue,
				rationale: params.rationale,
			});
			return textResult(`Recorded ${decision.id}: ${decision.status}`, decision);
		},
	});

	pi.registerTool({
		name: "metamp_write_recipe",
		label: "Write Recipe",
		description: "Write a recipe file under recipes/ only, with overwrite protection by default.",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
			overwrite: Type.Optional(Type.Boolean()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const recipePath = params.path.startsWith("recipes/") ? params.path : `recipes/${params.path}`;
			const absolute = assertProjectRelativeUnder(root, recipePath, "recipes");
			if (!params.overwrite) {
				try {
					await readFile(absolute, "utf8");
					throw new Error(`${recipePath} already exists; set overwrite=true to replace it`);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			await mkdir(path.dirname(absolute), { recursive: true });
			await writeFile(absolute, params.content, "utf8");
			return textResult(`Wrote ${toProjectRelative(root, absolute)}`, { path: toProjectRelative(root, absolute) });
		},
	});

	pi.registerTool({
		name: "metamp_run_recipe",
		label: "Run Recipe",
		description: "Execute a recipe through the tracked local backend and create a run manifest.",
		parameters: Type.Object({
			path: Type.String(),
			inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			parentRunId: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const backend = new LocalPythonExecutionBackend();
			const result = await backend.runRecipe(
				{ projectRoot: root, recipePath: params.path, inputs: params.inputs, parentRunId: params.parentRunId },
				signal,
			);
			return textResult(`${result.manifest.runId}: ${result.manifest.status}`, result.manifest);
		},
	});

	pi.registerTool({
		name: "metamp_read_run",
		label: "Read Run",
		description: "Read a tracked run manifest and captured stdout/stderr.",
		parameters: Type.Object({ runId: Type.String() }),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const run = await readRun(root, params.runId);
			const stdout = await readFile(path.join(root, run.stdoutPath), "utf8").catch(() => "");
			const stderr = await readFile(path.join(root, run.stderrPath), "utf8").catch(() => "");
			return textResult(`${run.runId}: ${run.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
				run,
				stdout,
				stderr,
			});
		},
	});

	pi.registerTool({
		name: "metamp_compare_runs",
		label: "Compare Runs",
		description: "Compare metrics and outputs across tracked runs.",
		parameters: Type.Object({ runIds: Type.Array(Type.String()) }),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const runs = await Promise.all(params.runIds.map((runId) => readRun(root, runId)));
			return textResult(
				runs
					.map(
						(run) =>
							`${run.runId}: ${run.status} metrics=${JSON.stringify(run.metrics)} outputs=${JSON.stringify(run.outputs)}`,
					)
					.join("\n"),
				{ runs },
			);
		},
	});

	pi.registerTool({
		name: "metamp_promote_run",
		label: "Promote Run",
		description: "Promote a successful run after user approval.",
		parameters: Type.Object({ runId: Type.String() }),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const project = await promoteRun(root, params.runId);
			return textResult(`Promoted ${params.runId}`, project);
		},
	});

	pi.registerTool({
		name: "metamp_handoff_context",
		label: "Handoff Context",
		description: "Build and persist deterministic handoff context from .metamp manifests.",
		parameters: Type.Object({
			goal: Type.Optional(Type.String()),
			conversationSummary: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const handoff = await writeHandoff(root, params);
			return textResult(`Wrote ${handoff.path}\n\n${handoff.content}`, handoff);
		},
	});

	pi.registerTool({
		name: "metamp_profile_dataset",
		label: "Profile Dataset",
		description: "Create a lightweight dataset profile report from registered schema metadata.",
		parameters: Type.Object({ datasetId: Type.String() }),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const state = await loadProjectState(root);
			const dataset = state.datasets.datasets.find((entry) => entry.id === params.datasetId);
			if (!dataset) throw new Error(`Unknown dataset ${params.datasetId}`);
			const reportPath = path.join(root, "reports", `${dataset.id}-profile.json`);
			await mkdir(path.dirname(reportPath), { recursive: true });
			const report = { dataset, generatedAt: new Date().toISOString() };
			await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
			dataset.profileArtifactPath = toProjectRelative(root, reportPath);
			dataset.updatedAt = new Date().toISOString();
			await writeYamlFile(path.join(root, ".metamp", "datasets.yaml"), state.datasets);
			return textResult(`Wrote ${dataset.profileArtifactPath}`, report);
		},
	});
}
