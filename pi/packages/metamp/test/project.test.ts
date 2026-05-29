import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proposeDecision, recordDecision } from "../src/decisions/decision-store.ts";
import { buildHandoffMarkdown } from "../src/handoff/build-handoff.ts";
import { initProject } from "../src/project/init.ts";
import {
	assertInsidePathCanonical,
	assertProjectRelativeUnder,
	assertProjectRelativeUnderCanonical,
	findProjectRoot,
} from "../src/project/paths.ts";
import { assertProjectPythonEnv, getPythonVersion } from "../src/project/python-env.ts";
import { formatProjectState, loadProjectState } from "../src/project/state.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-test-"));
}

describe("Metamp project manifests", () => {
	it("initializes manifests and detects the project root from nested directories", async () => {
		const cwd = await tempRoot();
		const result = await initProject("taxi fare", cwd);
		const nested = path.join(result.root, "recipes", "nested");
		await writeFile(path.join(result.root, "recipes", "placeholder.txt"), "ok", "utf8");
		const python = await assertProjectPythonEnv(result.root);
		const version = await getPythonVersion(python.pythonPath);

		expect(python.relativePythonPath).toBe(
			process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
		);
		expect(version).toMatch(/^Python \d+\./);
		await expect(findProjectRoot(nested)).resolves.toBe(result.root);
		const state = await loadProjectState(result.root);
		expect(state.project.name).toBe("taxi-fare");
		expect(state.datasets.datasets).toEqual([]);
		expect(state.approvals.approvals).toEqual([]);
		expect(state.namespaceManifests.map((manifest) => manifest.namespace)).toEqual([
			"profiles",
			"schema",
			"quality",
			"leakage",
			"experiments",
			"interpretations",
			"reproducibility",
			"reports",
		]);
		await expect(readFile(path.join(result.root, ".metamp", "approvals.yaml"), "utf8")).resolves.toContain(
			"approvals: []",
		);
		const leakageDir = await stat(path.join(result.root, "reports", "leakage"));
		expect(leakageDir.isDirectory()).toBe(true);
		expect(formatProjectState(state)).toContain("Project: taxi-fare");
	});

	it("fails init without writing manifests when venv creation fails", async () => {
		const cwd = await tempRoot();
		const emptyPath = path.join(cwd, "empty-bin");
		await mkdir(emptyPath);
		const pathEnvKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const originalPath = process.env[pathEnvKey];
		process.env[pathEnvKey] = emptyPath;
		try {
			await expect(initProject("broken", cwd)).rejects.toThrow("Failed to create project Python environment");
		} finally {
			if (originalPath === undefined) {
				delete process.env[pathEnvKey];
			} else {
				process.env[pathEnvKey] = originalPath;
			}
		}

		await expect(readFile(path.join(cwd, "broken", ".metamp", "project.yaml"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(findProjectRoot(path.join(cwd, "broken"))).resolves.toBeUndefined();
		const retry = await initProject("broken", cwd);
		expect(retry.root).toBe(path.join(cwd, "broken"));
	});

	it("rejects project-relative paths that escape allowed directories", async () => {
		const cwd = await tempRoot();
		const result = await initProject("safe", cwd);
		expect(() => assertProjectRelativeUnder(result.root, "recipes/train.py", "recipes")).not.toThrow();
		expect(() => assertProjectRelativeUnder(result.root, "recipes/../data/train.csv", "recipes")).toThrow(
			"must stay inside",
		);
	});

	it("rejects sibling prefix collisions with canonical path checks", async () => {
		const cwd = await tempRoot();
		const result = await initProject("prefix", cwd);
		const sibling = path.join(path.dirname(result.root), `${path.basename(result.root)}-evil`, "report.md");
		await expect(assertInsidePathCanonical(result.root, sibling, "prefix collision")).rejects.toThrow(
			"must stay inside",
		);
	});

	it("rejects symlink escapes from allowed directories", async () => {
		const cwd = await tempRoot();
		const result = await initProject("symlink", cwd);
		const outside = await tempRoot();
		const linkPath = path.join(result.root, "recipes", "linked");
		await symlink(outside, linkPath);

		await expect(
			assertProjectRelativeUnderCanonical(result.root, "recipes/linked/train.py", "recipes"),
		).rejects.toThrow("must stay inside");
		await expect(assertProjectRelativeUnderCanonical(result.root, "recipes/train.py", "recipes")).resolves.toBe(
			path.join(result.root, "recipes", "train.py"),
		);
	});

	it("fails fast on unsupported manifest schema versions", async () => {
		const cwd = await tempRoot();
		const result = await initProject("schema", cwd);
		const manifestPath = path.join(result.root, ".metamp", "project.yaml");
		const manifestText = await readFile(manifestPath, "utf8");
		await writeFile(manifestPath, manifestText.replace("schemaVersion: 1", "schemaVersion: 2"), "utf8");

		await expect(loadProjectState(result.root)).rejects.toThrow("Unsupported .metamp manifest schema version");
	});

	it("fails fast on malformed optional manifests", async () => {
		const cwd = await tempRoot();
		const result = await initProject("optional", cwd);
		await writeFile(path.join(result.root, ".metamp", "approvals.yaml"), "schemaVersion: 1\napprovals: {}\n", "utf8");

		await expect(loadProjectState(result.root)).rejects.toThrow("approvals manifest.approvals must be an array");
	});

	it("fails fast on malformed run manifests", async () => {
		const cwd = await tempRoot();
		const result = await initProject("runs", cwd);
		const runDir = path.join(result.root, ".metamp", "runs", "run_001");
		await mkdir(runDir, { recursive: true });
		await writeFile(
			path.join(runDir, "manifest.yaml"),
			"schemaVersion: 1\nrunId: run_001\nstatus: succeeded\ncommand: []\n",
			"utf8",
		);

		await expect(loadProjectState(result.root)).rejects.toThrow("run manifest.inputs must be an object");
	});

	it("records decision lifecycle state durably", async () => {
		const cwd = await tempRoot();
		const result = await initProject("decisions", cwd);
		const pending = await proposeDecision(result.root, {
			type: "target",
			proposedValue: "fare_amount",
			rationale: "Column is numeric and business-relevant.",
		});
		const approved = await recordDecision(result.root, { id: pending.id, status: "approved" });
		const state = await loadProjectState(result.root);

		expect(approved.approvedValue).toBe("fare_amount");
		expect(state.decisions.decisions[0]?.status).toBe("approved");
		await expect(recordDecision(result.root, { id: pending.id, status: "rejected" })).rejects.toThrow(
			"Decision approved cannot transition to rejected",
		);
	});

	it("builds handoff content from manifests instead of chat history", async () => {
		const cwd = await tempRoot();
		const result = await initProject("handoff", cwd);
		const state = await loadProjectState(result.root);
		const markdown = buildHandoffMarkdown(state, { goal: "train a baseline" });

		expect(markdown).toContain("# Metamp Handoff");
		expect(markdown).toContain("train a baseline");
		expect(markdown).toContain("## Current Project State");
	});
});
