import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const METAMP_DIR = ".metamp";
export const PROJECT_MANIFEST = "project.yaml";
export const DATASETS_MANIFEST = "datasets.yaml";
export const DECISIONS_MANIFEST = "decisions.yaml";

export interface MetampPaths {
	root: string;
	dataDir: string;
	recipesDir: string;
	reportsDir: string;
	artifactsDir: string;
	metampDir: string;
	runsDir: string;
	handoffsDir: string;
	projectManifest: string;
	datasetsManifest: string;
	decisionsManifest: string;
}

export function getMetampPaths(root: string): MetampPaths {
	const metampDir = path.join(root, METAMP_DIR);
	return {
		root,
		dataDir: path.join(root, "data"),
		recipesDir: path.join(root, "recipes"),
		reportsDir: path.join(root, "reports"),
		artifactsDir: path.join(root, "artifacts"),
		metampDir,
		runsDir: path.join(metampDir, "runs"),
		handoffsDir: path.join(metampDir, "handoffs"),
		projectManifest: path.join(metampDir, PROJECT_MANIFEST),
		datasetsManifest: path.join(metampDir, DATASETS_MANIFEST),
		decisionsManifest: path.join(metampDir, DECISIONS_MANIFEST),
	};
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function findProjectRoot(startDir: string): Promise<string | undefined> {
	let current = path.resolve(startDir);
	for (;;) {
		if (await exists(path.join(current, METAMP_DIR, PROJECT_MANIFEST))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export async function requireProjectRoot(startDir: string): Promise<string> {
	const root = await findProjectRoot(startDir);
	if (!root) {
		throw new Error("Not inside a Metamp project. Run `metamp init <name>` first.");
	}
	return root;
}

export function resolveProjectPath(root: string, candidate: string): string {
	return path.resolve(root, candidate);
}

export function isInsidePath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertInsidePath(parent: string, child: string, label = "path"): void {
	if (!isInsidePath(path.resolve(parent), path.resolve(child))) {
		throw new Error(`${label} must stay inside ${parent}`);
	}
}

export function toProjectRelative(root: string, absolutePath: string): string {
	assertInsidePath(root, absolutePath);
	return path.relative(root, absolutePath).split(path.sep).join("/");
}

export function assertProjectRelativeUnder(root: string, relativePath: string, allowedDir: string): string {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`${relativePath} must be project-relative`);
	}
	const resolved = path.resolve(root, relativePath);
	assertInsidePath(path.join(root, allowedDir), resolved, relativePath);
	return resolved;
}

export async function realpathIfExists(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(filePath);
		throw error;
	}
}

export async function ensureProjectDirs(root: string): Promise<void> {
	const paths = getMetampPaths(root);
	await Promise.all([
		mkdir(paths.dataDir, { recursive: true }),
		mkdir(paths.recipesDir, { recursive: true }),
		mkdir(paths.reportsDir, { recursive: true }),
		mkdir(paths.artifactsDir, { recursive: true }),
		mkdir(paths.runsDir, { recursive: true }),
		mkdir(paths.handoffsDir, { recursive: true }),
	]);
}
