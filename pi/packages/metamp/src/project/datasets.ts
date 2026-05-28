import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeYamlFile } from "../manifests/io.ts";
import {
	type DatasetColumn,
	type DatasetManifestEntry,
	type DatasetStorageMode,
	type DatasetsManifest,
	METAMP_SCHEMA_VERSION,
} from "../manifests/schema.ts";
import { assertInsidePath, getMetampPaths, isInsidePath, toProjectRelative } from "./paths.ts";
import { loadProjectState, saveProjectManifest } from "./state.ts";

export interface RegisterDatasetOptions {
	mode: DatasetStorageMode;
}

export interface RegisterDatasetResult {
	dataset: DatasetManifestEntry;
	warning?: string;
}

async function hashFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const bytes = await readFile(filePath);
	hash.update(bytes);
	return `sha256:${hash.digest("hex")}`;
}

function nextDatasetId(datasets: DatasetsManifest): string {
	let max = 0;
	for (const dataset of datasets.datasets) {
		const match = /^dataset_(\d+)$/.exec(dataset.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `dataset_${String(max + 1).padStart(3, "0")}`;
}

function inferScalarType(values: string[]): DatasetColumn["inferredType"] {
	const nonEmpty = values.filter((value) => value.trim() !== "");
	if (nonEmpty.length === 0) return "empty";
	if (nonEmpty.every((value) => /^(true|false)$/i.test(value.trim()))) return "boolean";
	if (nonEmpty.every((value) => /^[-+]?\d+$/.test(value.trim()))) return "integer";
	if (nonEmpty.every((value) => Number.isFinite(Number(value.trim())))) return "number";
	return "string";
}

export function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (quoted && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (char === "," && !quoted) {
			cells.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	cells.push(current);
	return cells.map((cell) => cell.trim());
}

function sniffCsvColumns(text: string): DatasetColumn[] {
	const lines = text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.slice(0, 26);
	if (lines.length === 0) return [];
	const headers = parseCsvLine(lines[0]);
	const rows = lines.slice(1).map(parseCsvLine);
	return headers.map((name, index) => {
		const values = rows.map((row) => row[index] ?? "");
		return {
			name,
			inferredType: inferScalarType(values),
			nonEmptyCount: values.filter((value) => value.trim() !== "").length,
		};
	});
}

function sniffJsonColumns(text: string): DatasetColumn[] {
	const value = JSON.parse(text) as unknown;
	const first = Array.isArray(value) ? value[0] : value;
	if (!first || typeof first !== "object" || Array.isArray(first)) return [];
	return Object.entries(first).map(([name, sample]) => ({
		name,
		inferredType:
			typeof sample === "number"
				? Number.isInteger(sample)
					? "integer"
					: "number"
				: typeof sample === "boolean"
					? "boolean"
					: sample === null || sample === undefined
						? "empty"
						: "string",
		nonEmptyCount: sample === null || sample === undefined || sample === "" ? 0 : 1,
	}));
}

export async function sniffDatasetColumns(filePath: string, fileType: string): Promise<DatasetColumn[]> {
	if (fileType !== "csv" && fileType !== "json" && fileType !== "jsonl") return [];
	const bytes = await readFile(filePath);
	const prefix = bytes.subarray(0, 64 * 1024).toString("utf8");
	if (fileType === "csv") return sniffCsvColumns(prefix);
	if (fileType === "json") return sniffJsonColumns(prefix);
	const firstLine = prefix.split(/\r?\n/, 1)[0];
	return firstLine ? sniffJsonColumns(firstLine) : [];
}

function fileTypeFor(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
	return ext || "unknown";
}

async function uniqueDataPath(dataDir: string, sourcePath: string): Promise<string> {
	const parsed = path.parse(path.basename(sourcePath));
	let candidate = path.join(dataDir, path.basename(sourcePath));
	for (let index = 1; ; index++) {
		try {
			await stat(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
			throw error;
		}
		candidate = path.join(dataDir, `${parsed.name}-${index}${parsed.ext}`);
	}
}

export async function registerDataset(
	root: string,
	inputPath: string,
	options: RegisterDatasetOptions,
): Promise<RegisterDatasetResult> {
	const state = await loadProjectState(root);
	const sourceAbsolute = path.resolve(process.cwd(), inputPath);
	await stat(sourceAbsolute);
	const paths = getMetampPaths(root);
	let storedPath: string;
	let warning: string | undefined;
	if (options.mode === "copy") {
		await mkdir(paths.dataDir, { recursive: true });
		const target = await uniqueDataPath(paths.dataDir, sourceAbsolute);
		assertInsidePath(paths.dataDir, target, "dataset target");
		await copyFile(sourceAbsolute, target);
		storedPath = toProjectRelative(root, target);
	} else {
		storedPath = isInsidePath(root, sourceAbsolute) ? toProjectRelative(root, sourceAbsolute) : sourceAbsolute;
		if (!isInsidePath(root, sourceAbsolute)) {
			warning = "Linked dataset is outside the Metamp project; keep the source path stable for reproducibility.";
		}
	}

	const fileType = fileTypeFor(sourceAbsolute);
	const stats = await stat(sourceAbsolute);
	const dataset: DatasetManifestEntry = {
		id: nextDatasetId(state.datasets),
		originalPath: sourceAbsolute,
		storedPath,
		storageMode: options.mode,
		fileType,
		sizeBytes: stats.size,
		contentHash: await hashFile(sourceAbsolute),
		columns: await sniffDatasetColumns(sourceAbsolute, fileType),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		warning,
	};
	const datasets = {
		schemaVersion: METAMP_SCHEMA_VERSION,
		datasets: [...state.datasets.datasets, dataset],
	} satisfies DatasetsManifest;
	await writeYamlFile(paths.datasetsManifest, datasets);
	if (!state.project.activeDatasetId) {
		await saveProjectManifest(root, {
			...state.project,
			activeDatasetId: dataset.id,
			updatedAt: new Date().toISOString(),
		});
	}
	return { dataset, warning };
}
