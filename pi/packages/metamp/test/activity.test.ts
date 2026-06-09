import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendMetampActivity,
	formatMetampActivity,
	readMetampActivity,
	readRecentMetampActivity,
} from "../src/activity/log.ts";
import { initProject } from "../src/project/init.ts";
import { getMetampPaths } from "../src/project/paths.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "metamp-activity-"));
}

describe("Metamp activity log", () => {
	it("appends and reads durable activity entries", async () => {
		const cwd = await tempRoot();
		const project = await initProject("activity", cwd);

		await appendMetampActivity(project.root, {
			timestamp: "2026-01-01T00:00:00.000Z",
			kind: "run",
			subjectId: "run_001",
			status: "started",
			message: "run recipes/train.py",
			metadata: { recipePath: "recipes/train.py" },
		});
		await appendMetampActivity(project.root, {
			timestamp: "2026-01-01T00:00:01.000Z",
			kind: "promotion",
			subjectId: "run_001",
			status: "promoted",
			message: "Promoted run_001",
		});

		const events = await readMetampActivity(project.root);
		expect(events).toHaveLength(2);
		expect(events[0]?.kind).toBe("run");
		expect(events[1]?.status).toBe("promoted");
		expect(formatMetampActivity(events)).toContain("promotion/promoted run_001 - Promoted run_001");
	});

	it("renders only the requested recent activity window", async () => {
		const cwd = await tempRoot();
		const project = await initProject("recent", cwd);
		for (let index = 0; index < 6; index += 1) {
			await appendMetampActivity(project.root, {
				timestamp: `2026-01-01T00:00:0${index}.000Z`,
				kind: "decision",
				subjectId: `decision_${index}`,
				status: "pending",
				message: `Decision ${index}`,
			});
		}

		const recent = await readRecentMetampActivity(project.root, 3);
		expect(recent).toHaveLength(3);
		expect(recent.map((event) => event.subjectId)).toEqual(["decision_3", "decision_4", "decision_5"]);
		expect(formatMetampActivity(recent)).not.toContain("decision_0");
	});

	it("stores only explicit structured event fields", async () => {
		const cwd = await tempRoot();
		const project = await initProject("sanitized", cwd);
		const secretReasoning = "hidden reasoning that must not be stored";

		await appendMetampActivity(project.root, {
			timestamp: "2026-01-01T00:00:00.000Z",
			kind: "approval",
			subjectId: "approval_001",
			status: "pending",
			message: "Approval requested for reports/schema.md",
			metadata: { targetResource: "reports/schema.md" },
		});

		const rawLog = await readFile(getMetampPaths(project.root).activityLogPath, "utf8");
		expect(rawLog).toContain("reports/schema.md");
		expect(rawLog).not.toContain(secretReasoning);
	});
});
