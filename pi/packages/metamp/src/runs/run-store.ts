import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readYamlFile, touchProject, writeYamlFile } from "../manifests/io.ts";
import { METAMP_SCHEMA_VERSION, type ProjectManifest, type RunManifest, type RunStatus } from "../manifests/schema.ts";
import { validateRunManifest } from "../manifests/validation.ts";
import {
	assertInsidePathCanonical,
	assertProjectRelativeUnderCanonical,
	getMetampPaths,
	toProjectRelative,
} from "../project/paths.ts";

const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
	queued: ["queued", "running", "cancelled"],
	running: ["running", "succeeded", "failed", "cancelled"],
	succeeded: ["succeeded"],
	failed: ["failed"],
	cancelled: ["cancelled"],
};

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

function formatRunId(index: number): string {
	return `run_${String(index).padStart(3, "0")}`;
}

function assertRunStatusTransition(current: RunStatus, next: RunStatus): void {
	if (ALLOWED_RUN_TRANSITIONS[current].includes(next)) return;
	throw new Error(`Invalid run status transition ${current} -> ${next}`);
}

function outputRoots(root: string, runId: string): string[] {
	return [path.join(root, "artifacts"), path.join(root, "reports"), runDir(root, runId)];
}

export async function assertRunOutputPath(
	root: string,
	runId: string,
	outputPath: string,
	requireRegularFile = false,
): Promise<string> {
	const absolute = path.resolve(root, outputPath);
	let allowed = false;
	for (const candidateRoot of outputRoots(root, runId)) {
		try {
			await assertInsidePathCanonical(candidateRoot, absolute, outputPath);
			allowed = true;
			break;
		} catch {}
	}
	if (!allowed) {
		throw new Error(`Output path ${outputPath} must be under artifacts/, reports/, or the current run directory`);
	}
	if (requireRegularFile) {
		const fileInfo = await stat(absolute);
		if (!fileInfo.isFile()) throw new Error(`Output path ${outputPath} must reference a regular file`);
	}
	return absolute;
}

async function reserveRunDirectory(root: string): Promise<{ runId: string; dir: string }> {
	const runsDir = getMetampPaths(root).runsDir;
	await mkdir(runsDir, { recursive: true });
	for (let index = 1; ; index += 1) {
		const runId = formatRunId(index);
		const dir = path.join(runsDir, runId);
		try {
			await mkdir(dir);
			return { runId, dir };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
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
			runs.push(validateRunManifest(await readYamlFile<unknown>(manifestPath), manifestPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return runs.sort((a, b) => runNumber(a.runId) - runNumber(b.runId));
}

export async function allocateRunId(root: string): Promise<string> {
	const runs = await listRuns(root);
	const max = runs.reduce((value, run) => Math.max(value, runNumber(run.runId)), 0);
	return formatRunId(max + 1);
}

export function runDir(root: string, runId: string): string {
	if (!/^run_\d+$/.test(runId)) {
		throw new Error(`Invalid run id ${runId}`);
	}
	return path.join(getMetampPaths(root).runsDir, runId);
}

export async function readRun(root: string, runId: string): Promise<RunManifest> {
	const manifestPath = path.join(runDir(root, runId), "manifest.yaml");
	return validateRunManifest(await readYamlFile<unknown>(manifestPath), manifestPath);
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
	const recipeAbsolute = await assertProjectRelativeUnderCanonical(root, input.recipePath, "recipes");
	const recipeRelative = toProjectRelative(root, recipeAbsolute);
	const { runId, dir } = await reserveRunDirectory(root);
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
	assertRunStatusTransition(manifest.status, status);
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
		await assertRunOutputPath(root, run.runId, value, true);
	}
	const paths = getMetampPaths(root);
	const project = await readYamlFile<ProjectManifest>(paths.projectManifest);
	const next = touchProject({ ...project, promotedRunId: runId });
	await writeYamlFile(paths.projectManifest, next);
	return next;
}
