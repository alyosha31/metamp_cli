import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createApprovalRequest, recordApprovalRequest } from "../approvals/approval-store.ts";
import { proposeDecision, recordDecision } from "../decisions/decision-store.ts";
import { LocalPythonExecutionBackend } from "../execution/local-python.ts";
import { writeHandoff } from "../handoff/build-handoff.ts";
import { readOptionalYamlFile, writeYamlFile } from "../manifests/io.ts";
import {
	type ApprovalAction,
	BUILTIN_MANIFEST_NAMESPACES,
	type BuiltinManifestNamespace,
	DECISION_TYPES,
	type DecisionStatus,
	type DecisionType,
	type ManifestNamespace,
	METAMP_SCHEMA_VERSION,
	type NamespacedEntry,
	type NamespacedNotesManifest,
} from "../manifests/schema.ts";
import { registerDataset } from "../project/datasets.ts";
import {
	assertProjectRelativeUnderCanonical,
	getMetampPaths,
	requireProjectRoot,
	toProjectRelative,
} from "../project/paths.ts";
import { formatProjectState, loadProjectState } from "../project/state.ts";
import { promoteRun, readRun } from "../runs/run-store.ts";
import { listMetampSubagents } from "../subagents/agents.ts";
import { discoverMetampSubagents, findMetampAgentSpec } from "../subagents/discovery.ts";
import { classifyRequestedAction } from "../subagents/policy.ts";
import {
	applyMetampSubagentProgress,
	createMetampSubagentProgressState,
	snapshotMetampSubagentProgress,
} from "../subagents/progress.ts";
import { runMetampSubagent, subagentTextResult } from "../subagents/runner.ts";

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

async function subagentModelOptions(ctx: ExtensionContext): Promise<{ model?: string; apiKey?: string }> {
	if (!ctx.model) return {};
	return {
		model: `${ctx.model.provider}/${ctx.model.id}`,
		apiKey: await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider),
	};
}

async function rootFromCtx(ctx: ExtensionContext): Promise<string> {
	return requireProjectRoot(ctx.cwd);
}

const decisionTypes = DECISION_TYPES;
const decisionStatuses = ["approved", "rejected", "superseded"] as const;
const approvalStatuses = ["approved", "rejected", "superseded"] as const;
const approvalActions = ["write_manifest", "write_report", "write_recipe", "write_artifact", "decision"] as const;
const manifestNamespaceSet = new Set<string>(BUILTIN_MANIFEST_NAMESPACES);

function isManifestNamespace(value: string): value is ManifestNamespace {
	return manifestNamespaceSet.has(value) || /^custom\.[a-z0-9][a-z0-9._-]*$/.test(value);
}

function namespaceManifestPath(root: string, namespace: ManifestNamespace): string {
	const paths = getMetampPaths(root);
	if (manifestNamespaceSet.has(namespace)) {
		return paths.namespaceManifests[namespace as BuiltinManifestNamespace];
	}
	return path.join(paths.metampDir, `${namespace}.yaml`);
}

function emptyNamespaceManifest(namespace: ManifestNamespace): NamespacedNotesManifest {
	return { schemaVersion: METAMP_SCHEMA_VERSION, namespace, entries: [] };
}

async function readNamespaceManifest(root: string, namespace: ManifestNamespace): Promise<NamespacedNotesManifest> {
	return readOptionalYamlFile<NamespacedNotesManifest>(
		namespaceManifestPath(root, namespace),
		emptyNamespaceManifest(namespace),
	);
}

function nextNamespacedEntryId(manifest: NamespacedNotesManifest): string {
	let max = 0;
	const prefix = manifest.namespace.replaceAll(".", "_");
	for (const entry of manifest.entries) {
		const match = new RegExp(`^${prefix}_(\\d+)$`).exec(entry.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `${prefix}_${String(max + 1).padStart(3, "0")}`;
}

function approvalText(approvalId: string, targetResource: string): string {
	return `Created approval request ${approvalId} for ${targetResource}. Ask the user or parent copilot to approve or reject it before relying on the proposed change.`;
}

async function requireSubagent(root: string, agentName: string) {
	const agent = await findMetampAgentSpec(agentName, { projectRoot: root });
	if (!agent) {
		const available = (await discoverMetampSubagents({ projectRoot: root })).map((item) => item.name).join(", ");
		throw new Error(`Unknown Metamp subagent ${agentName}. Available agents: ${available}`);
	}
	return agent;
}

async function writeOrRequestOwnedReport(
	root: string,
	agentName: string,
	relativePath: string,
	content: string,
	overwrite: boolean,
	rationale?: string,
): Promise<AgentToolResult<unknown>> {
	const agent = await requireSubagent(root, agentName);
	const reportPath = relativePath.startsWith("reports/") ? relativePath : `reports/${relativePath}`;
	const classification = classifyRequestedAction(agent, { kind: "write_report", relativePath: reportPath });
	if (classification === "denied") throw new Error(`${agent.name} cannot write ${reportPath}`);
	if (classification === "approval_required") {
		const approval = await createApprovalRequest(root, {
			requester: agent.name,
			action: "write_report",
			targetResource: reportPath,
			proposedValue: { path: reportPath, content, overwrite },
			rationale: rationale ?? `${agent.name} requested a cross-scope report write.`,
		});
		return textResult(approvalText(approval.id, reportPath), approval);
	}
	const absolute = await assertProjectRelativeUnderCanonical(root, reportPath, "reports");
	if (!overwrite) {
		try {
			await readFile(absolute, "utf8");
			throw new Error(`${reportPath} already exists; set overwrite=true to replace it`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await mkdir(path.dirname(absolute), { recursive: true });
	await writeFile(absolute, content, "utf8");
	return textResult(`Wrote ${toProjectRelative(root, absolute)}`, { path: toProjectRelative(root, absolute) });
}

async function updateOrRequestOwnedManifest(
	root: string,
	agentName: string,
	namespace: ManifestNamespace,
	entry: { id?: string; kind: string; value: unknown; rationale?: string; evidence?: string[] },
): Promise<AgentToolResult<unknown>> {
	const agent = await requireSubagent(root, agentName);
	const targetResource = `.metamp/${namespace}.yaml`;
	const classification = classifyRequestedAction(agent, { kind: "write_manifest", namespace });
	if (classification === "approval_required") {
		const approval = await createApprovalRequest(root, {
			requester: agent.name,
			action: "write_manifest",
			targetResource,
			proposedValue: { namespace, entry },
			rationale: entry.rationale ?? `${agent.name} requested a cross-scope manifest update.`,
		});
		return textResult(approvalText(approval.id, targetResource), approval);
	}
	if (classification === "denied") throw new Error(`${agent.name} cannot update ${targetResource}`);
	const manifest = await readNamespaceManifest(root, namespace);
	const now = new Date().toISOString();
	const index = entry.id ? manifest.entries.findIndex((candidate) => candidate.id === entry.id) : -1;
	const updated: NamespacedEntry = {
		id: entry.id ?? nextNamespacedEntryId(manifest),
		owner: agent.name,
		kind: entry.kind,
		value: entry.value,
		rationale: entry.rationale,
		evidence: entry.evidence,
		createdAt: index >= 0 ? manifest.entries[index].createdAt : now,
		updatedAt: now,
	};
	const entries = [...manifest.entries];
	if (index >= 0) entries[index] = updated;
	else entries.push(updated);
	const nextManifest: NamespacedNotesManifest = { schemaVersion: METAMP_SCHEMA_VERSION, namespace, entries };
	await writeYamlFile(namespaceManifestPath(root, namespace), nextManifest);
	return textResult(`Updated ${targetResource}: ${updated.id}`, updated);
}

export function registerMetampTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "metamp_project_state",
		label: "Metamp State",
		description: "Read current Metamp project, dataset, decision, run, namespace, and approval manifests.",
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
		description:
			"Persist a pending material ML decision, or create an approval request when a subagent lacks authority.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Metamp subagent requesting the decision" })),
			type: Type.Union(decisionTypes.map((type) => Type.Literal(type))),
			proposedValue: Type.Unknown(),
			rationale: Type.Optional(Type.String()),
			sourceRunId: Type.Optional(Type.String()),
			sourceArtifactPath: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const type = params.type as DecisionType;
			if (params.agent) {
				const agent = await requireSubagent(root, params.agent);
				const classification = classifyRequestedAction(agent, {
					kind: "decision",
					decisionType: type,
					mode: "propose",
				});
				if (classification === "approval_required") {
					const targetResource = `decision:${type}`;
					const approval = await createApprovalRequest(root, {
						requester: agent.name,
						action: "decision",
						targetResource,
						proposedValue: params.proposedValue,
						rationale: params.rationale ?? `${agent.name} requested a material decision outside its authority.`,
					});
					return textResult(approvalText(approval.id, targetResource), approval);
				}
			}
			const decision = await proposeDecision(root, {
				type,
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
		name: "metamp_record_approval",
		label: "Record Approval",
		description: "Record an approved, rejected, or superseded approval request.",
		parameters: Type.Object({
			id: Type.String(),
			status: Type.Union(approvalStatuses.map((status) => Type.Literal(status))),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const approval = await recordApprovalRequest(root, {
				id: params.id,
				status: params.status as (typeof approvalStatuses)[number],
			});
			return textResult(`Recorded ${approval.id}: ${approval.status}`, approval);
		},
	});
	pi.registerTool({
		name: "metamp_write_owned_report",
		label: "Write Owned Report",
		description:
			"Allow a Metamp subagent to write reports only inside its owned report directories; cross-scope writes become approval requests.",
		parameters: Type.Object({
			agent: Type.String(),
			path: Type.String({ description: "Project-relative reports path, e.g. reports/schema/grain.md" }),
			content: Type.String(),
			overwrite: Type.Optional(Type.Boolean()),
			rationale: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			return writeOrRequestOwnedReport(
				root,
				params.agent,
				params.path,
				params.content,
				params.overwrite ?? false,
				params.rationale,
			);
		},
	});

	pi.registerTool({
		name: "metamp_update_owned_manifest",
		label: "Update Owned Manifest",
		description:
			"Allow a Metamp subagent to upsert notes only inside its owned namespace manifest; cross-scope writes become approval requests.",
		parameters: Type.Object({
			agent: Type.String(),
			namespace: Type.String({ description: "Manifest namespace such as schema, leakage, or custom.pricing" }),
			entry: Type.Object({
				id: Type.Optional(Type.String()),
				kind: Type.String(),
				value: Type.Unknown(),
				rationale: Type.Optional(Type.String()),
				evidence: Type.Optional(Type.Array(Type.String())),
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!isManifestNamespace(params.namespace)) throw new Error(`Invalid manifest namespace ${params.namespace}`);
			const root = await rootFromCtx(ctx);
			return updateOrRequestOwnedManifest(root, params.agent, params.namespace, params.entry);
		},
	});

	pi.registerTool({
		name: "metamp_request_cross_scope_change",
		label: "Request Cross-Scope Change",
		description: "Create a durable approval request for a subagent action outside its ownership scope.",
		parameters: Type.Object({
			agent: Type.String(),
			action: Type.Union(approvalActions.map((action) => Type.Literal(action))),
			targetResource: Type.String(),
			targetOwner: Type.Optional(Type.String()),
			proposedValue: Type.Unknown(),
			rationale: Type.String(),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const agent = await requireSubagent(root, params.agent);
			const approval = await createApprovalRequest(root, {
				requester: agent.name,
				action: params.action as ApprovalAction,
				targetResource: params.targetResource,
				targetOwner: params.targetOwner,
				proposedValue: params.proposedValue,
				rationale: params.rationale,
			});
			return textResult(approvalText(approval.id, params.targetResource), approval);
		},
	});

	pi.registerTool({
		name: "metamp_list_subagents",
		label: "List Metamp Subagents",
		description: "List bundled and discovered Metamp subagents with ownership scopes and decision authority.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const agents = await discoverMetampSubagents({ projectRoot: root });
			const text = agents
				.map(
					(agent) =>
						`${agent.name} (${agent.source}): ${agent.description}\n  owns manifests=${agent.owns.manifests.join(", ") || "none"}; reports=${agent.owns.reportDirs.join(", ") || "none"}`,
				)
				.join("\n");
			return textResult(text || "No Metamp subagents", { agents });
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
			const absolute = await assertProjectRelativeUnderCanonical(root, recipePath, "recipes");
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
		name: "metamp_subagent",
		label: "Metamp Subagent",
		description:
			"Run one Metamp data-science subagent with isolated context. Available bundled agents: " +
			listMetampSubagents()
				.map((agent) => agent.name)
				.join(", "),
		parameters: Type.Object({
			agent: Type.String({ description: "Metamp subagent name" }),
			task: Type.String({ description: "Task for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Optional working directory for the subagent process" })),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			const root = await rootFromCtx(ctx);
			const agent = await findMetampAgentSpec(params.agent, { projectRoot: root });
			let allowProjectLocalAgent = false;
			if (agent?.requiresConfirmation) {
				if (!ctx.hasUI) {
					throw new Error(
						`Project-local Metamp subagent ${agent.name} requires interactive confirmation before execution`,
					);
				}
				const confirmed = await ctx.ui.confirm(
					"Run project-local Metamp subagent",
					`Run ${agent.name} from ${agent.definitionPath ?? "project configuration"}?`,
				);
				if (!confirmed) return textResult(`Cancelled ${agent.name}`, { agent: agent.name, cancelled: true });
				allowProjectLocalAgent = true;
			}
			const progressState = createMetampSubagentProgressState(params.agent, params.task);
			const modelOptions = await subagentModelOptions(ctx);
			const result = await runMetampSubagent({
				projectRoot: root,
				agentName: params.agent,
				task: params.task,
				cwd: params.cwd,
				signal,
				...modelOptions,
				allowProjectLocalAgent,
				onProgress(event) {
					applyMetampSubagentProgress(progressState, event);
					onUpdate?.({
						content: [{ type: "text", text: event.text }],
						details: { progress: snapshotMetampSubagentProgress(progressState) },
					});
				},
			});
			return subagentTextResult(result);
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
