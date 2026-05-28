import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunManifest } from "../manifests/schema.ts";
import { assertInsidePath, assertProjectRelativeUnder, toProjectRelative } from "../project/paths.ts";
import { assertProjectPythonEnv, getPythonVersion } from "../project/python-env.ts";
import { createQueuedRun, runDir, updateRunStatus } from "../runs/run-store.ts";
import type { ExecutionBackend, RunRecipeInput, RunRecipeResult } from "./backend.ts";

function parseRecord(text: string, label: string): Record<string, unknown> {
	if (text.trim() === "") return {};
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function parseMetrics(text: string): RunManifest["metrics"] {
	const record = parseRecord(text, "metrics.json");
	const metrics: RunManifest["metrics"] = {};
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === "number" || typeof value === "string" || typeof value === "boolean" || value === null) {
			metrics[key] = value;
		}
	}
	return metrics;
}

async function readJsonIfExists(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function validateOutputPaths(root: string, runId: string, outputs: Record<string, unknown>): void {
	const allowed = [path.join(root, "artifacts"), path.join(root, "reports"), runDir(root, runId)];
	for (const value of Object.values(outputs)) {
		if (typeof value !== "string") continue;
		const absolute = path.resolve(root, value);
		if (
			!allowed.some((dir) => {
				try {
					assertInsidePath(dir, absolute);
					return true;
				} catch {
					return false;
				}
			})
		) {
			throw new Error(`Output path ${value} must be under artifacts/, reports/, or the current run directory`);
		}
	}
}

export class LocalPythonExecutionBackend implements ExecutionBackend {
	readonly kind = "local-python";

	async runRecipe(input: RunRecipeInput, signal?: AbortSignal): Promise<RunRecipeResult> {
		const recipeAbsolute = assertProjectRelativeUnder(input.projectRoot, input.recipePath, "recipes");
		const recipeRelative = toProjectRelative(input.projectRoot, recipeAbsolute);
		const python = await assertProjectPythonEnv(input.projectRoot);
		const version = await getPythonVersion(python.pythonPath);
		const pythonMetadata: NonNullable<RunManifest["python"]> = { executable: python.relativePythonPath };
		if (version) pythonMetadata.version = version;
		const manifest = await createQueuedRun(input.projectRoot, {
			recipePath: recipeRelative,
			command: [python.relativePythonPath, recipeRelative],
			python: pythonMetadata,
			inputs: input.inputs,
			parentRunId: input.parentRunId,
		});
		const dir = runDir(input.projectRoot, manifest.runId);
		await mkdir(dir, { recursive: true });
		const stdoutPath = path.join(input.projectRoot, manifest.stdoutPath);
		const stderrPath = path.join(input.projectRoot, manifest.stderrPath);
		const logsPath = path.join(input.projectRoot, manifest.logsPath);
		const metricsPath = path.join(dir, "metrics.json");
		const outputsPath = path.join(dir, "outputs.json");
		const startedAt = new Date().toISOString();
		let current = await updateRunStatus(input.projectRoot, manifest, "running", { startedAt });
		let stdout = "";
		let stderr = "";

		const child = spawn(python.pythonPath, [recipeRelative], {
			cwd: input.projectRoot,
			env: {
				...process.env,
				METAMP_PROJECT_ROOT: input.projectRoot,
				METAMP_RUN_ID: manifest.runId,
				METAMP_RUN_DIR: dir,
				METAMP_METRICS_FILE: metricsPath,
				METAMP_OUTPUTS_FILE: outputsPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		try {
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			const exitCode = await new Promise<number | null>((resolve, reject) => {
				child.on("error", reject);
				child.on("close", (code) => resolve(code));
			});
			await Promise.all([
				writeFile(stdoutPath, stdout, "utf8"),
				writeFile(stderrPath, stderr, "utf8"),
				writeFile(logsPath, `${stdout}${stderr}`, "utf8"),
			]);
			const outputs = parseRecord(await readJsonIfExists(outputsPath), "outputs.json");
			validateOutputPaths(input.projectRoot, manifest.runId, outputs);
			const metrics = parseMetrics(await readJsonIfExists(metricsPath));
			const endedAt = new Date().toISOString();
			current = await updateRunStatus(input.projectRoot, current, exitCode === 0 ? "succeeded" : "failed", {
				endedAt,
				exitCode,
				outputs,
				metrics,
				error: exitCode === 0 ? undefined : `Recipe exited with code ${exitCode}`,
			});
			return { manifest: current, stdout, stderr };
		} catch (error) {
			const endedAt = new Date().toISOString();
			await Promise.all([
				writeFile(stdoutPath, stdout, "utf8"),
				writeFile(stderrPath, stderr, "utf8"),
				writeFile(logsPath, `${stdout}${stderr}`, "utf8"),
			]);
			current = await updateRunStatus(input.projectRoot, current, signal?.aborted ? "cancelled" : "failed", {
				endedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			return { manifest: current, stdout, stderr };
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
}
