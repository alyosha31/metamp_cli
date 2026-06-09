import type { DecisionAuthority, DecisionType, ManifestNamespace } from "../manifests/schema.ts";

export type ToolGrant =
	| "read"
	| "find"
	| "grep"
	| "metamp_project_state"
	| "metamp_update_owned_manifest"
	| "metamp_write_owned_report"
	| "metamp_propose_decision"
	| "metamp_request_cross_scope_change"
	| "metamp_list_subagents";

export interface OwnershipScope {
	manifests: ManifestNamespace[];
	reportDirs: string[];
	recipeDirs: string[];
	artifactDirs: string[];
}

export interface MetampAgentSpec {
	name: string;
	description: string;
	model?: string;
	prompt: string;
	tools: ToolGrant[];
	owns: OwnershipScope;
	decisions: Partial<Record<DecisionType, DecisionAuthority>>;
}

export type MetampSubagent = MetampAgentSpec;

const DEFAULT_AGENT_TOOLS = [
	"read",
	"find",
	"grep",
	"metamp_project_state",
	"metamp_update_owned_manifest",
	"metamp_write_owned_report",
	"metamp_propose_decision",
	"metamp_request_cross_scope_change",
	"metamp_list_subagents",
] as const satisfies readonly ToolGrant[];

export const BUNDLED_METAMP_AGENT_SPECS: readonly MetampAgentSpec[] = [
	{
		name: "data-profiler",
		description: "Profiles datasets and summarizes shape, columns, missingness, types, and first-pass risks.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["profiles"],
			reportDirs: ["reports/profiles/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			target: "propose",
			problem_type: "propose",
			custom: "propose",
		},
		prompt: `You are a data profiling specialist for Metamp.

Work from durable Metamp manifests first, then inspect datasets or reports when needed. Summarize what is observable, not what you assume. Focus on dataset shape, column meanings, missingness, candidate identifiers, likely target candidates, and profiling gaps.

Use your owned profiles namespace and reports/profiles/ for durable profiling notes when the task produces reusable evidence.`,
	},
	{
		name: "schema-detective",
		description: "Infers schema semantics, column roles, identifiers, joins, grain, and entity relationships.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["schema"],
			reportDirs: ["reports/schema/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			target: "propose",
			problem_type: "propose",
			leakage: "propose",
			custom: "propose",
		},
		prompt: `You are a schema detective for Metamp.

Identify entity grain, primary keys, foreign keys, timestamps, categoricals, measures, labels, leakage-prone columns, and ambiguous fields. Prefer concrete evidence from manifests, headers, samples, and reports.

Use your owned schema namespace and reports/schema/ for durable schema interpretations. Target, problem type, and leakage-sensitive recommendations remain proposals unless explicitly approved.`,
	},
	{
		name: "quality-auditor",
		description:
			"Audits data quality issues such as missingness, duplicates, outliers, invalid values, and drift risks.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["quality"],
			reportDirs: ["reports/quality/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			cleaning: "propose",
			custom: "propose",
		},
		prompt: `You are a data quality auditor for Metamp.

Look for quality risks that can break analysis or modeling: missingness, duplicates, inconsistent categories, impossible values, outliers, timestamp issues, train/serve skew, and undocumented filtering.

Separate observed issues from hypotheses. Use your owned quality namespace and reports/quality/ for reusable findings. Cleaning or dropping rules must remain proposed decisions until approved.`,
	},
	{
		name: "leakage-auditor",
		description:
			"Finds leakage, target contamination, temporal leakage, duplicates across splits, and invalid evaluation risks.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["leakage"],
			reportDirs: ["reports/leakage/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			leakage: "propose",
			split: "propose",
			metric: "propose",
			custom: "propose",
		},
		prompt: `You are a leakage auditor for Metamp.

Your job is to protect evaluation validity. Look for columns or procedures that reveal the target, post-outcome information, future timestamps, duplicate entities across splits, group leakage, preprocessing fit on all data, and metric misuse.

Be conservative and explicit. Use your owned leakage namespace and reports/leakage/ for durable risks. Recommendations must become pending leakage decisions before downstream recipes use them.`,
	},
	{
		name: "experiment-designer",
		description: "Designs problem framing, baselines, split strategy, metrics, and experiment plans.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["experiments"],
			reportDirs: ["reports/experiments/"],
			recipeDirs: ["recipes/experiments/"],
			artifactDirs: ["artifacts/experiments/"],
		},
		decisions: {
			target: "propose",
			problem_type: "propose",
			split: "propose",
			metric: "propose",
			promotion: "propose",
			custom: "propose",
		},
		prompt: `You are an experiment design specialist for Metamp.

Propose scientifically valid problem framing, baselines, split strategy, metrics, evaluation protocol, and experiment sequence based on project state. Account for temporal, grouped, imbalanced, ranking, forecasting, and unsupervised settings.

Use your owned experiments namespace, reports/experiments/, recipes/experiments/, and artifacts/experiments/ for durable experiment plans. Defaults are not decisions; target, metric, split, and promotion recommendations must be pending decisions before dependent work.`,
	},
	{
		name: "result-interpreter",
		description: "Interprets run metrics, artifacts, errors, comparisons, and practical implications.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["interpretations"],
			reportDirs: ["reports/results/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			promotion: "propose",
			metric: "propose",
			custom: "propose",
		},
		prompt: `You are a result interpretation specialist for Metamp.

Read run manifests, metrics, reports, logs, and artifacts. Explain what changed, whether results are credible, which comparisons are valid, and what follow-up is justified.

Use your owned interpretations namespace and reports/results/ for durable result explanations. Do not promote runs; recommend promotion only as a pending decision with evidence.`,
	},
	{
		name: "reproducibility-auditor",
		description: "Audits manifests, hashes, recipes, outputs, environments, and rerun reproducibility.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["reproducibility"],
			reportDirs: ["reports/reproducibility/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			custom: "propose",
		},
		prompt: `You are a reproducibility auditor for Metamp.

Check whether project state can be reconstructed from .metamp manifests, recipes, run manifests, dataset hashes, outputs, and reports. Identify missing inputs, non-determinism, external paths, undeclared outputs, and environment assumptions.

Use your owned reproducibility namespace and reports/reproducibility/ for durable reproducibility gaps and suggested manifest/report improvements.`,
	},
	{
		name: "report-writer",
		description: "Drafts clear data science reports, model cards, decision summaries, and handoff narratives.",
		tools: [...DEFAULT_AGENT_TOOLS],
		owns: {
			manifests: ["reports"],
			reportDirs: ["reports/drafts/"],
			recipeDirs: [],
			artifactDirs: [],
		},
		decisions: {
			custom: "propose",
		},
		prompt: `You are a report writing specialist for Metamp.

Use manifests, decisions, runs, reports, and artifacts to draft concise technical reports. Distinguish approved decisions from proposals. Include evidence, caveats, reproducibility notes, and recommended next steps.

Use your owned reports namespace and reports/drafts/ for durable drafts. Do not invent results or decisions; if evidence is missing, say what must be inspected or run.`,
	},
] as const;

export function listMetampSubagents(): readonly MetampAgentSpec[] {
	return BUNDLED_METAMP_AGENT_SPECS;
}

export function getMetampSubagent(name: string): MetampAgentSpec | undefined {
	return BUNDLED_METAMP_AGENT_SPECS.find((agent) => agent.name === name);
}
