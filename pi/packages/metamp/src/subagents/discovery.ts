import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
	BUILTIN_MANIFEST_NAMESPACES,
	DECISION_TYPES,
	type DecisionAuthority,
	type DecisionType,
	type ManifestNamespace,
} from "../manifests/schema.ts";
import { BUNDLED_METAMP_AGENT_SPECS, type MetampAgentSpec, type ToolGrant } from "./agents.ts";

export type AgentSource = "bundled" | "user" | "project";

export interface DiscoveredMetampAgentSpec extends MetampAgentSpec {
	source: AgentSource;
	definitionPath?: string;
	requiresConfirmation: boolean;
}

export interface DiscoverMetampSubagentsOptions {
	projectRoot?: string;
	userHome?: string;
}

const TOOL_ALIASES: Readonly<Record<string, ToolGrant>> = {
	read_project_state: "metamp_project_state",
	inspect_dataset: "read",
	write_owned_report: "metamp_write_owned_report",
	update_owned_manifest: "metamp_update_owned_manifest",
	propose_decision: "metamp_propose_decision",
	request_cross_scope_change: "metamp_request_cross_scope_change",
	list_subagents: "metamp_list_subagents",
};

const TOOL_GRANTS = new Set<ToolGrant>([
	"read",
	"find",
	"grep",
	"metamp_project_state",
	"metamp_update_owned_manifest",
	"metamp_write_owned_report",
	"metamp_propose_decision",
	"metamp_request_cross_scope_change",
	"metamp_list_subagents",
]);

const DECISION_AUTHORITIES = new Set<DecisionAuthority>(["none", "propose", "approve"]);
const DECISION_TYPE_SET = new Set<string>(DECISION_TYPES);
const BUILTIN_NAMESPACE_SET = new Set<string>(BUILTIN_MANIFEST_NAMESPACES);
const PROTECTED_MANIFESTS = new Set<string>(["project", "datasets", "runs", "decisions", "approvals"]);
const PROTECTED_REPORT_DIRS = new Set<string>([
	"reports/profiles/",
	"reports/schema/",
	"reports/quality/",
	"reports/leakage/",
	"reports/experiments/",
	"reports/results/",
	"reports/reproducibility/",
	"reports/drafts/",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function stringArrayValue(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function normalizeDirectory(value: string, requiredPrefix: "reports" | "recipes" | "artifacts"): string | undefined {
	if (value.includes("\0")) return undefined;
	const withSlashes = value.replaceAll("\\", "/");
	if (path.posix.isAbsolute(withSlashes)) return undefined;
	const normalized = path.posix.normalize(withSlashes);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
	const withTrailingSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
	if (!withTrailingSlash.startsWith(`${requiredPrefix}/`)) return undefined;
	if (withTrailingSlash === `${requiredPrefix}/`) return undefined;
	return withTrailingSlash;
}

function parseManifestNamespace(value: string): ManifestNamespace | undefined {
	if (BUILTIN_NAMESPACE_SET.has(value)) return value as ManifestNamespace;
	if (/^custom\.[a-z0-9][a-z0-9._-]*$/.test(value)) return value as ManifestNamespace;
	return undefined;
}

function parseToolGrant(value: string): ToolGrant | undefined {
	const aliased = TOOL_ALIASES[value];
	if (aliased) return aliased;
	return TOOL_GRANTS.has(value as ToolGrant) ? (value as ToolGrant) : undefined;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } | undefined {
	if (!text.startsWith("---\n")) return undefined;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return undefined;
	const rawFrontmatter = text.slice(4, end);
	const afterMarker = text.slice(end + "\n---".length);
	const body = afterMarker.startsWith("\n") ? afterMarker.slice(1) : afterMarker;
	const parsed = YAML.parse(rawFrontmatter) as unknown;
	if (!isRecord(parsed)) return undefined;
	return { frontmatter: parsed, body: body.trim() };
}

function parseDecisions(
	frontmatter: Record<string, unknown>,
	source: AgentSource,
	filePath: string,
): Partial<Record<DecisionType, DecisionAuthority>> {
	const raw = frontmatter.decisions;
	if (!isRecord(raw)) return {};
	const decisions: Partial<Record<DecisionType, DecisionAuthority>> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!DECISION_TYPE_SET.has(key)) continue;
		if (typeof value !== "string" || !DECISION_AUTHORITIES.has(value as DecisionAuthority)) {
			throw new Error(`${filePath}: decisions.${key} must be none, propose, or approve`);
		}
		if (source !== "bundled" && value === "approve") {
			throw new Error(`${filePath}: custom agents may not approve material global decisions`);
		}
		decisions[key as DecisionType] = value as DecisionAuthority;
	}
	return decisions;
}

function parseOwnership(
	frontmatter: Record<string, unknown>,
	name: string,
	source: AgentSource,
	filePath: string,
): MetampAgentSpec["owns"] {
	const owns = frontmatter.owns;
	if (!isRecord(owns)) return { manifests: [], reportDirs: [], recipeDirs: [], artifactDirs: [] };
	const manifests: ManifestNamespace[] = [];
	for (const value of stringArrayValue(owns, "manifests")) {
		if (PROTECTED_MANIFESTS.has(value)) throw new Error(`${filePath}: ${value} is a protected manifest namespace`);
		const namespace = parseManifestNamespace(value);
		if (!namespace) throw new Error(`${filePath}: invalid manifest namespace ${value}`);
		if (source !== "bundled" && !namespace.startsWith("custom.")) {
			throw new Error(`${filePath}: custom agents may only own custom.* manifest namespaces`);
		}
		manifests.push(namespace);
	}
	const reportKeys = [...stringArrayValue(owns, "reportDirs"), ...stringArrayValue(owns, "reports")];
	const reportDirs = reportKeys.map((value) => {
		const dir = normalizeDirectory(value, "reports");
		if (!dir) throw new Error(`${filePath}: report directory ${value} must stay under reports/`);
		if (source !== "bundled" && PROTECTED_REPORT_DIRS.has(dir) && dir !== `reports/${name}/`) {
			throw new Error(`${filePath}: custom agents may not own bundled report directory ${dir}`);
		}
		return dir;
	});
	const recipeDirs = stringArrayValue(owns, "recipeDirs")
		.concat(stringArrayValue(owns, "recipes"))
		.map((value) => {
			const dir = normalizeDirectory(value, "recipes");
			if (!dir) throw new Error(`${filePath}: recipe directory ${value} must stay under recipes/`);
			return dir;
		});
	const artifactDirs = stringArrayValue(owns, "artifactDirs")
		.concat(stringArrayValue(owns, "artifacts"))
		.map((value) => {
			const dir = normalizeDirectory(value, "artifacts");
			if (!dir) throw new Error(`${filePath}: artifact directory ${value} must stay under artifacts/`);
			return dir;
		});
	return { manifests, reportDirs, recipeDirs, artifactDirs };
}

function parseCustomAgent(text: string, filePath: string, source: AgentSource): DiscoveredMetampAgentSpec {
	const parsed = parseFrontmatter(text);
	if (!parsed) throw new Error(`${filePath}: custom agent file must start with YAML frontmatter`);
	const name = stringValue(parsed.frontmatter, "name");
	if (!name || !/^[a-z][a-z0-9-]*$/.test(name))
		throw new Error(`${filePath}: agent name must be lowercase kebab-case`);
	const description = stringValue(parsed.frontmatter, "description");
	if (!description) throw new Error(`${filePath}: description is required`);
	const tools = stringArrayValue(parsed.frontmatter, "tools").map((value) => {
		const grant = parseToolGrant(value);
		if (!grant) throw new Error(`${filePath}: unsupported tool grant ${value}`);
		return grant;
	});
	return {
		name,
		description,
		model: stringValue(parsed.frontmatter, "model"),
		prompt: parsed.body,
		tools,
		owns: parseOwnership(parsed.frontmatter, name, source, filePath),
		decisions: parseDecisions(parsed.frontmatter, source, filePath),
		source,
		definitionPath: filePath,
		requiresConfirmation: source === "project",
	};
}

async function readCustomAgentDirectory(dir: string, source: AgentSource): Promise<DiscoveredMetampAgentSpec[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const agents: DiscoveredMetampAgentSpec[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(dir, entry);
		agents.push(parseCustomAgent(await readFile(filePath, "utf8"), filePath, source));
	}
	return agents;
}

function bundledAgents(): DiscoveredMetampAgentSpec[] {
	return BUNDLED_METAMP_AGENT_SPECS.map((agent) => ({
		...agent,
		source: "bundled",
		requiresConfirmation: false,
	}));
}

export async function discoverMetampSubagents(
	options: DiscoverMetampSubagentsOptions = {},
): Promise<readonly DiscoveredMetampAgentSpec[]> {
	const byName = new Map<string, DiscoveredMetampAgentSpec>();
	for (const agent of bundledAgents()) byName.set(agent.name, agent);
	const userDir = path.join(options.userHome ?? os.homedir(), ".metamp", "agent", "agents");
	for (const agent of await readCustomAgentDirectory(userDir, "user")) byName.set(agent.name, agent);
	if (options.projectRoot) {
		const projectDir = path.join(options.projectRoot, ".metamp", "agents");
		for (const agent of await readCustomAgentDirectory(projectDir, "project")) byName.set(agent.name, agent);
	}
	return [...byName.values()];
}

export async function findMetampAgentSpec(
	name: string,
	options: DiscoverMetampSubagentsOptions = {},
): Promise<DiscoveredMetampAgentSpec | undefined> {
	const agents = await discoverMetampSubagents(options);
	return agents.find((agent) => agent.name === name);
}
