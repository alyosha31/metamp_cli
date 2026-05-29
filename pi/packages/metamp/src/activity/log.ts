import { appendFile, mkdir, readFile } from "node:fs/promises";
import { getMetampPaths } from "../project/paths.ts";

export type MetampActivityKind = "run" | "promotion" | "decision" | "approval" | "subagent";

export interface MetampActivityEvent {
	timestamp: string;
	kind: MetampActivityKind;
	subjectId: string;
	status: string;
	message: string;
	metadata?: Record<string, unknown>;
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return 20;
	return Math.min(200, Math.floor(limit));
}

export async function appendMetampActivity(root: string, event: MetampActivityEvent): Promise<void> {
	const logPath = getMetampPaths(root).activityLogPath;
	await mkdir(getMetampPaths(root).metampDir, { recursive: true });
	await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readMetampActivity(root: string): Promise<MetampActivityEvent[]> {
	const logPath = getMetampPaths(root).activityLogPath;
	let content: string;
	try {
		content = await readFile(logPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const events: MetampActivityEvent[] = [];
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line) as unknown;
		if (!parsed || typeof parsed !== "object") throw new Error("Invalid Metamp activity log entry");
		events.push(parsed as MetampActivityEvent);
	}
	return events;
}

export async function readRecentMetampActivity(root: string, limit = 20): Promise<MetampActivityEvent[]> {
	const events = await readMetampActivity(root);
	return events.slice(-normalizeLimit(limit));
}

export function formatMetampActivity(events: readonly MetampActivityEvent[]): string {
	if (events.length === 0) return "No Metamp activity yet.";
	return events
		.map((event) => `${event.timestamp} ${event.kind}/${event.status} ${event.subjectId} - ${event.message}`)
		.join("\n");
}
