import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proposeDecision, recordDecision } from "../src/decisions/decision-store.ts";
import { buildHandoffMarkdown } from "../src/handoff/build-handoff.ts";
import { initProject } from "../src/project/init.ts";
import { assertProjectRelativeUnder, findProjectRoot } from "../src/project/paths.ts";
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
