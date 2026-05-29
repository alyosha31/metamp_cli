export type MetampSubagentProgressKind =
	| "started"
	| "status"
	| "thinking"
	| "text"
	| "tool_started"
	| "tool_update"
	| "tool_finished"
	| "error"
	| "completed"
	| "aborted";

export interface MetampSubagentProgressEvent {
	type: MetampSubagentProgressKind;
	text: string;
	toolName?: string;
	exitCode?: number;
}

export interface MetampSubagentProgressState {
	agentName: string;
	task: string;
	status: string;
	thinking: string;
	drafting: string;
	activity: string[];
	currentTool?: string;
	recentTools: string[];
	terminalState: "running" | "completed" | "aborted" | "error";
}

const MAX_ACTIVITY_LINES = 6;
const MAX_RECENT_TOOLS = 4;
const MAX_BUFFER_CHARS = 500;

function compactProgressText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function appendUnique(items: string[], value: string, limit: number): void {
	if (!value || items.at(-1) === value) return;
	items.push(value);
	while (items.length > limit) items.shift();
}

function appendActivity(state: MetampSubagentProgressState, line: string): void {
	appendUnique(state.activity, compactProgressText(line), MAX_ACTIVITY_LINES);
}

function appendRecentTool(state: MetampSubagentProgressState, toolName: string | undefined): void {
	if (!toolName) return;
	appendUnique(state.recentTools, toolName, MAX_RECENT_TOOLS);
}

export function createMetampSubagentProgressState(agentName: string, task: string): MetampSubagentProgressState {
	return {
		agentName,
		task,
		status: "starting",
		thinking: "",
		drafting: "",
		activity: [],
		recentTools: [],
		terminalState: "running",
	};
}

export function applyMetampSubagentProgress(
	state: MetampSubagentProgressState,
	event: MetampSubagentProgressEvent,
): void {
	switch (event.type) {
		case "thinking":
			state.status = "thinking";
			state.thinking = `${state.thinking}${event.text}`.slice(-MAX_BUFFER_CHARS);
			return;
		case "text":
			state.status = "drafting";
			state.drafting = `${state.drafting}${event.text}`.slice(-MAX_BUFFER_CHARS);
			return;
		case "tool_started":
		case "tool_update":
		case "tool_finished":
			state.status = event.type.replaceAll("_", " ");
			state.currentTool = event.toolName;
			appendRecentTool(state, event.toolName);
			appendActivity(state, event.text);
			if (event.type === "tool_finished") state.currentTool = undefined;
			return;
		case "completed":
			state.status = "completed";
			state.terminalState = "completed";
			appendActivity(state, event.text);
			return;
		case "aborted":
			state.status = "aborted";
			state.terminalState = "aborted";
			appendActivity(state, event.text);
			return;
		case "error":
			state.status = "error";
			state.terminalState = "error";
			appendActivity(state, event.text);
			return;
		case "started":
		case "status":
			state.status = event.type === "started" ? "started" : compactProgressText(event.text) || state.status;
			appendActivity(state, event.text);
			return;
	}
}

export function snapshotMetampSubagentProgress(state: MetampSubagentProgressState): Record<string, unknown> {
	return {
		agentName: state.agentName,
		task: state.task,
		status: state.status,
		terminalState: state.terminalState,
		currentTool: state.currentTool,
		recentTools: [...state.recentTools],
		activity: [...state.activity],
		thinking: compactProgressText(state.thinking),
		drafting: compactProgressText(state.drafting),
	};
}
