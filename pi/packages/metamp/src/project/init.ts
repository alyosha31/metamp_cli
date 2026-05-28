import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { writeYamlFile } from "../manifests/io.ts";
import {
	type DatasetsManifest,
	type DecisionsManifest,
	METAMP_SCHEMA_VERSION,
	type ProjectManifest,
} from "../manifests/schema.ts";
import { ensureProjectDirs, findProjectRoot, getMetampPaths } from "./paths.ts";

export interface InitProjectResult {
	root: string;
	created: boolean;
	project: ProjectManifest;
}

function slugifyProjectName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug || slug === "." || slug === "..") {
		throw new Error("Project name must contain at least one letter or number");
	}
	return slug;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function initProject(name: string, cwd: string): Promise<InitProjectResult> {
	const projectRoot = name === "." ? path.resolve(cwd) : path.resolve(cwd, slugifyProjectName(name));
	const existingRoot = await findProjectRoot(projectRoot);
	if (existingRoot && existingRoot === projectRoot) {
		throw new Error(`${projectRoot} is already a Metamp project`);
	}
	if (name !== "." && (await pathExists(path.join(projectRoot, ".metamp")))) {
		throw new Error(`${projectRoot} already contains .metamp`);
	}

	await ensureProjectDirs(projectRoot);
	const paths = getMetampPaths(projectRoot);
	const now = new Date().toISOString();
	const project: ProjectManifest = {
		schemaVersion: METAMP_SCHEMA_VERSION,
		projectId: `metamp_${randomUUID()}`,
		name: name === "." ? path.basename(projectRoot) : slugifyProjectName(name),
		root: projectRoot,
		createdAt: now,
		updatedAt: now,
	};
	const datasets: DatasetsManifest = { schemaVersion: METAMP_SCHEMA_VERSION, datasets: [] };
	const decisions: DecisionsManifest = { schemaVersion: METAMP_SCHEMA_VERSION, decisions: [] };

	await Promise.all([
		writeYamlFile(paths.projectManifest, project),
		writeYamlFile(paths.datasetsManifest, datasets),
		writeYamlFile(paths.decisionsManifest, decisions),
	]);

	return { root: projectRoot, created: true, project };
}
