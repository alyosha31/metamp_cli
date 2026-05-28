import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readYamlFile, touchProject, writeYamlFile } from "../manifests/io.ts";
import { METAMP_SCHEMA_VERSION, type ProjectManifest, type RunManifest, type RunStatus } from "../manifests/schema.ts";
import { assertProjectRelativeUnder, getMetampPaths, toProjectRelative } from "../project/paths.ts";

export async function hashFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const bytes = await readFile(filePath);
	hash.update(bytes);
	return `sha256:${hash.digest("hex")}`;
}

function runNumber(runId: string): number {
	const match = /^run_(\d+)$/.exec(runId);
	return match ? Number(match[1]) : 0;
}

export async function listRuns(root: string): Promise<RunManifest[]> {
	const runsDir = getMetampPaths(root).runsDir;
	let entries: string[];
	try {
		entries = await readdir(runsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const runs: RunManifest[] = [];
	for (const entry of entries) {
		if (!/^run_\d+$/.test(entry)) continue;
		const manifestPath = path.join(runsDir, entry, "manifest.yaml");
		try {
			runs.push(await readYamlFile<RunManifest>(manifestPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return runs.sort((a, b) => runNumber(a.runId) - runNumber(b.runId));
}

export async function allocateRunId(root: string): Promise<string> {
	const runs = await listRuns(root);
	const max = runs.reduce((value, run) => Math.max(value, runNumber(run.runId)), 0);
	return `run_${String(max + 1).padStart(3, "0")}`;
}

export function runDir(root: string, runId: string): string {
	if (!/^run_\d+$/.test(runId)) {
		throw new Error(`Invalid run id ${runId}`);
	}
	return path.join(getMetampPaths(root).runsDir, runId);
}

export async function readRun(root: string, runId: string): Promise<RunManifest> {
	return readYamlFile<RunManifest>(path.join(runDir(root, runId), "manifest.yaml"));
}

export async function writeRun(root: string, manifest: RunManifest): Promise<void> {
	await writeYamlFile(path.join(runDir(root, manifest.runId), "manifest.yaml"), manifest);
}

export interface CreateRunInput {
	recipePath: string;
	command?: string[];
	python?: RunManifest["python"];
	inputs?: Record<string, unknown>;
	parentRunId?: string;
}

export async function createQueuedRun(root: string, input: CreateRunInput): Promise<RunManifest> {
	const recipeAbsolute = assertProjectRelativeUnder(root, input.recipePath, "recipes");
	const recipeRelative = toProjectRelative(root, recipeAbsolute);
	const runId = await allocateRunId(root);
	const dir = runDir(root, runId);
	const manifest: RunManifest = {
		schemaVersion: METAMP_SCHEMA_VERSION,
		runId,
		status: "queued",
		command: input.command ?? [recipeRelative],
		cwd: root,
		...(input.python ? { python: input.python } : {}),
		recipePath: recipeRelative,
		inputs: input.inputs ?? {},
		outputs: {},
		metrics: {},
		stdoutPath: toProjectRelative(root, path.join(dir, "stdout.txt")),
		stderrPath: toProjectRelative(root, path.join(dir, "stderr.txt")),
		logsPath: toProjectRelative(root, path.join(dir, "logs.txt")),
		codeHashes: {
			[recipeRelative]: await hashFile(recipeAbsolute),
		},
		parentRunId: input.parentRunId,
	};
	await writeRun(root, manifest);
	return manifest;
}

export async function updateRunStatus(
	root: string,
	manifest: RunManifest,
	status: RunStatus,
	updates: Partial<RunManifest> = {},
): Promise<RunManifest> {
	const next: RunManifest = { ...manifest, ...updates, status };
	await writeRun(root, next);
	return next;
}

export async function promoteRun(root: string, runId: string): Promise<ProjectManifest> {
	const run = await readRun(root, runId);
	if (run.status !== "succeeded") {
		throw new Error(`Only succeeded runs can be promoted; ${runId} is ${run.status}`);
	}
	for (const value of Object.values(run.outputs)) {
		if (typeof value !== "string") continue;
		const absolute = path.resolve(root, value);
		if (!absolute.startsWith(path.resolve(root))) continue;
		await stat(absolute);
	}
	const paths = getMetampPaths(root);
	const project = await readYamlFile<ProjectManifest>(paths.projectManifest);
	const next = touchProject({ ...project, promotedRunId: runId });
	await writeYamlFile(paths.projectManifest, next);
	return next;
}
