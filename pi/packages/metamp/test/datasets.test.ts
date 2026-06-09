import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsvLine, registerDataset } from "../src/project/datasets.ts";
import { initProject } from "../src/project/init.ts";
import { loadProjectState } from "../src/project/state.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-dataset-"));
}

describe("dataset registry", () => {
	it("parses quoted CSV headers", () => {
		expect(parseCsvLine('"pickup, zone",fare,"quoted ""cell"""')).toEqual(["pickup, zone", "fare", 'quoted "cell"']);
	});

	it("copies data, hashes it, and sniffs CSV columns without inferring ML decisions", async () => {
		const cwd = await tempRoot();
		const project = await initProject("taxi", cwd);
		const csvPath = path.join(cwd, "train.csv");
		await writeFile(csvPath, "fare_amount,passenger_count,is_cash\n12.5,1,true\n7,2,false\n", "utf8");

		const result = await registerDataset(project.root, csvPath, { mode: "copy" });
		const state = await loadProjectState(project.root);

		expect(result.dataset.id).toBe("dataset_001");
		expect(result.dataset.storedPath).toBe("data/train.csv");
		expect(result.dataset.contentHash).toMatch(/^sha256:/);
		expect(result.dataset.columns.map((column) => [column.name, column.inferredType])).toEqual([
			["fare_amount", "number"],
			["passenger_count", "integer"],
			["is_cash", "boolean"],
		]);
		expect(state.project.activeDatasetId).toBe("dataset_001");
		expect(state.project.activeTargetColumn).toBeUndefined();
	});

	it("links external data with a reproducibility warning", async () => {
		const cwd = await tempRoot();
		const project = await initProject("links", cwd);
		const externalDir = await tempRoot();
		const csvPath = path.join(externalDir, "external.csv");
		await writeFile(csvPath, "x\n1\n", "utf8");

		const result = await registerDataset(project.root, csvPath, { mode: "link" });

		expect(result.dataset.storedPath).toBe(csvPath);
		expect(result.warning).toContain("outside the Metamp project");
	});

	it("treats symlinked external data as external for canonical reproducibility checks", async () => {
		const cwd = await tempRoot();
		const project = await initProject("symlink-links", cwd);
		const externalDir = await tempRoot();
		const csvPath = path.join(externalDir, "linked.csv");
		await writeFile(csvPath, "x\n1\n", "utf8");
		const linkPath = path.join(project.root, "data", "linked.csv");
		await symlink(csvPath, linkPath);

		const result = await registerDataset(project.root, linkPath, { mode: "link" });

		expect(result.dataset.storedPath).toBe(linkPath);
		expect(result.warning).toContain("outside the Metamp project");
	});
});
