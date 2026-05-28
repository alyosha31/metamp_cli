import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalPythonExecutionBackend } from "../src/execution/local-python.ts";
import { initProject } from "../src/project/init.ts";
import { promoteRun, readRun } from "../src/runs/run-store.ts";

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
			`import json\nimport os\nfrom pathlib import Path\nprint("profile ok")\nprint("diagnostic", file=__import__("sys").stderr)\nreport = Path(os.environ["METAMP_PROJECT_ROOT"]) / "reports" / "profile.json"\nreport.write_text(json.dumps({"rows": 2}))\nPath(os.environ["METAMP_METRICS_FILE"]).write_text(json.dumps({"rmse": 1.25}))\nPath(os.environ["METAMP_OUTPUTS_FILE"]).write_text(json.dumps({"report": "reports/profile.json"}))\n`,
			"utf8",
		);

		const result = await new LocalPythonExecutionBackend().runRecipe({
			projectRoot: project.root,
			recipePath: "recipes/profile.py",
		});
		const manifest = await readRun(project.root, result.manifest.runId);
		const stdout = await readFile(path.join(project.root, manifest.stdoutPath), "utf8");
		const stderr = await readFile(path.join(project.root, manifest.stderrPath), "utf8");
		const promoted = await promoteRun(project.root, manifest.runId);

		expect(manifest.runId).toBe("run_001");
		expect(manifest.status).toBe("succeeded");
		expect(manifest.metrics).toEqual({ rmse: 1.25 });
		expect(manifest.outputs).toEqual({ report: "reports/profile.json" });
		expect(stdout).toContain("profile ok");
		expect(stderr).toContain("diagnostic");
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
});
