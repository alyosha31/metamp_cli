import path from "node:path";
import type { DecisionAuthority, DecisionType, ManifestNamespace } from "../manifests/schema.ts";
import type { MetampAgentSpec } from "./agents.ts";

export type RequestedAction =
	| { kind: "write_manifest"; namespace: ManifestNamespace }
	| { kind: "write_report"; relativePath: string }
	| { kind: "write_recipe"; relativePath: string }
	| { kind: "write_artifact"; relativePath: string }
	| { kind: "decision"; decisionType: DecisionType; mode?: "propose" | "approve" };

export type PolicyClassification = "allowed" | "approval_required" | "denied";

function normalizeProjectRelative(relativePath: string): string | undefined {
	if (relativePath.includes("\0")) return undefined;
	const withSlashes = relativePath.replaceAll("\\", "/");
	if (path.posix.isAbsolute(withSlashes)) return undefined;
	const normalized = path.posix.normalize(withSlashes);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
	return normalized;
}

function normalizeOwnedDir(dir: string): string | undefined {
	const normalized = normalizeProjectRelative(dir);
	if (!normalized) return undefined;
	return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function isUnderDirectory(relativePath: string, baseDir: string): boolean {
	const normalized = normalizeProjectRelative(relativePath);
	if (!normalized) return false;
	const normalizedBase = normalizeOwnedDir(baseDir);
	if (!normalizedBase) return false;
	return normalized.startsWith(normalizedBase) && normalized.length > normalizedBase.length;
}

function canWriteUnder(relativePath: string, ownedDirs: readonly string[]): boolean {
	return ownedDirs.some((dir) => isUnderDirectory(relativePath, dir));
}

export function canWriteManifest(agent: MetampAgentSpec, namespace: ManifestNamespace): boolean {
	return agent.owns.manifests.includes(namespace);
}

export function canWriteReport(agent: MetampAgentSpec, relativePath: string): boolean {
	return canWriteUnder(relativePath, agent.owns.reportDirs);
}

export function canWriteRecipe(agent: MetampAgentSpec, relativePath: string): boolean {
	return canWriteUnder(relativePath, agent.owns.recipeDirs);
}

export function canWriteArtifact(agent: MetampAgentSpec, relativePath: string): boolean {
	return canWriteUnder(relativePath, agent.owns.artifactDirs);
}

export function decisionAuthority(agent: MetampAgentSpec, decisionType: DecisionType): DecisionAuthority {
	return agent.decisions[decisionType] ?? "none";
}

function isValidScopedPath(relativePath: string, requiredDir: "reports" | "recipes" | "artifacts"): boolean {
	return isUnderDirectory(relativePath, `${requiredDir}/`);
}

export function classifyRequestedAction(agent: MetampAgentSpec, action: RequestedAction): PolicyClassification {
	switch (action.kind) {
		case "write_manifest":
			return canWriteManifest(agent, action.namespace) ? "allowed" : "approval_required";
		case "write_report":
			if (canWriteReport(agent, action.relativePath)) return "allowed";
			return isValidScopedPath(action.relativePath, "reports") ? "approval_required" : "denied";
		case "write_recipe":
			if (canWriteRecipe(agent, action.relativePath)) return "allowed";
			return isValidScopedPath(action.relativePath, "recipes") ? "approval_required" : "denied";
		case "write_artifact":
			if (canWriteArtifact(agent, action.relativePath)) return "allowed";
			return isValidScopedPath(action.relativePath, "artifacts") ? "approval_required" : "denied";
		case "decision": {
			const authority = decisionAuthority(agent, action.decisionType);
			if (action.mode === "approve") return authority === "approve" ? "allowed" : "approval_required";
			return authority === "propose" || authority === "approve" ? "allowed" : "approval_required";
		}
	}
}

function formatResourceList(agent: MetampAgentSpec): string[] {
	return [
		...agent.owns.manifests.map((namespace) => `.metamp/${namespace}.yaml`),
		...agent.owns.reportDirs,
		...agent.owns.recipeDirs,
		...agent.owns.artifactDirs,
	];
}

function decisionList(agent: MetampAgentSpec, authority: DecisionAuthority): string[] {
	return Object.entries(agent.decisions)
		.filter(([, value]) => value === authority)
		.map(([decisionType]) => decisionType)
		.sort();
}

function bulletList(items: readonly string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

export function generatePolicyPromptBlock(agent: MetampAgentSpec): string {
	const directWrites = formatResourceList(agent);
	const approves = decisionList(agent, "approve");
	const proposes = decisionList(agent, "propose");
	return `## your ownership
You are ${agent.name}.

You may directly write:
${bulletList(directWrites)}

You may approve material decisions:
${bulletList(approves)}

You may propose but not approve material decisions:
${bulletList(proposes)}

For owned durable notes, call metamp_update_owned_manifest or metamp_write_owned_report. For cross-ownership changes, call metamp_request_cross_scope_change. Policy is enforced by tools; do not use arbitrary file writes for durable Metamp state.`;
}
