import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { DatasetsManifest, DecisionsManifest, ProjectManifest } from "./schema.ts";

export async function readYamlFile<T>(filePath: string): Promise<T> {
	const text = await readFile(filePath, "utf8");
	return YAML.parse(text) as T;
}

export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, YAML.stringify(value, { lineWidth: 0 }), "utf8");
	await rename(tmpPath, filePath);
}

export async function readOptionalYamlFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return await readYamlFile<T>(filePath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return fallback;
		}
		throw error;
	}
}

export function touchProject(project: ProjectManifest, now = new Date().toISOString()): ProjectManifest {
	return { ...project, updatedAt: now };
}

export function assertManifestVersions(
	project: ProjectManifest,
	datasets: DatasetsManifest,
	decisions: DecisionsManifest,
): void {
	if (project.schemaVersion !== 1 || datasets.schemaVersion !== 1 || decisions.schemaVersion !== 1) {
		throw new Error("Unsupported .metamp manifest schema version");
	}
}
