import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalPythonExecutionBackend } from "../src/execution/local-python.ts";
import { initProject } from "../src/project/init.ts";
import { getPythonEnvPaths } from "../src/project/python-env.ts";
import { listRuns, promoteRun, readRun } from "../src/runs/run-store.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-run-"));
}

describe("tracked local recipe execution", () => {
	it("captures stdout, stderr, metrics, outputs, and promotion state", async () => {
		const cwd = await tempRoot();
		const project = await initProject("runs", cwd);
		await mkdir(path.join(project.root, "recipes"), { recursive: true });
		await writeFile(
			path.join(project.root, "recipes", "profile.py"),
			`import json\nimport os\nimport sys\nfrom pathlib import Path\nprint("profile ok")\nprint("python-prefix=" + sys.prefix)\nprint("diagnostic", file=__import__("sys").stderr)\nvenv = Path(os.environ["METAMP_PROJECT_ROOT"]) / ".venv"\nif Path(sys.prefix).resolve() != venv.resolve():\n    raise SystemExit(f"expected venv prefix {venv}, got {sys.prefix}")\nreport = Path(os.environ["METAMP_PROJECT_ROOT"]) / "reports" / "profile.json"\nreport.write_text(json.dumps({"rows": 2}))\nPath(os.environ["METAMP_METRICS_FILE"]).write_text(json.dumps({"rmse": 1.25}))\nPath(os.environ["METAMP_OUTPUTS_FILE"]).write_text(json.dumps({"report": "reports/profile.json"}))\n`,
			"utf8",
		);

		const result = await new LocalPythonExecutionBackend().runRecipe({
			projectRoot: project.root,
			recipePath: "recipes/profile.py",
		});
		const manifest = await readRun(project.root, result.manifest.runId);
		const python = getPythonEnvPaths(project.root);
		const stdout = await readFile(path.join(project.root, manifest.stdoutPath), "utf8");
		const stderr = await readFile(path.join(project.root, manifest.stderrPath), "utf8");
		const promoted = await promoteRun(project.root, manifest.runId);

		expect(manifest.runId).toBe("run_001");
		expect(manifest.status).toBe("succeeded");
		expect(manifest.metrics).toEqual({ rmse: 1.25 });
		expect(manifest.outputs).toEqual({ report: "reports/profile.json" });
		expect(manifest.command).toEqual([python.relativePythonPath, "recipes/profile.py"]);
		expect(manifest.python?.executable).toBe(python.relativePythonPath);
		expect(manifest.python?.version).toMatch(/^Python \d+\./);
		expect(stdout).toContain("profile ok");
		expect(stderr).toContain("diagnostic");
		expect(stdout).toContain("python-prefix=");
		expect(promoted.promotedRunId).toBe("run_001");
	});

	it("rejects recipes outside recipes/", async () => {
		const cwd = await tempRoot();
		const project = await initProject("blocked", cwd);
		await writeFile(path.join(project.root, "outside.py"), "print('bad')", "utf8");

		await expect(
			new LocalPythonExecutionBackend().runRecipe({ projectRoot: project.root, recipePath: "outside.py" }),
		).rejects.toThrow("must stay inside");
	});

	it("records failed recipes without suppressing the error", async () => {
		const cwd = await tempRoot();
		const project = await initProject("failed", cwd);
		await writeFile(path.join(project.root, "recipes", "fail.py"), "raise SystemExit(3)\n", "utf8");

		const result = await new LocalPythonExecutionBackend().runRecipe({
			projectRoot: project.root,
			recipePath: "recipes/fail.py",
		});

		expect(result.manifest.status).toBe("failed");
		expect(result.manifest.exitCode).toBe(3);
		expect(result.manifest.error).toContain("Recipe exited with code 3");
	});

	it("fails clearly instead of falling back when the project venv is missing", async () => {
		const cwd = await tempRoot();
		const project = await initProject("missing-env", cwd);
		await rm(path.join(project.root, ".venv"), { recursive: true, force: true });
		await writeFile(path.join(project.root, "recipes", "noop.py"), "print('should not run')\n", "utf8");

		const python = getPythonEnvPaths(project.root);
		await expect(
			new LocalPythonExecutionBackend().runRecipe({ projectRoot: project.root, recipePath: "recipes/noop.py" }),
		).rejects.toThrow(
			`Project Python environment is missing at ${python.relativePythonPath}. Run \`python3 -m venv .venv\` from the project root.`,
		);
		await expect(listRuns(project.root)).resolves.toEqual([]);
	});
});
