import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatProjectState, loadProjectState } from "../project/state.ts";
import { type DiscoveredMetampAgentSpec, discoverMetampSubagents, findMetampAgentSpec } from "./discovery.ts";
import { generatePolicyPromptBlock } from "./policy.ts";
import type { MetampSubagentProgressEvent } from "./progress.ts";

const ABORT_EXIT_CODE = 130;
const ABORT_KILL_DELAY_MS = 1_000;

export interface MetampSubagentRunInput {
	projectRoot: string;
	agentName: string;
	task: string;
	cwd?: string;
	signal?: AbortSignal;
	allowProjectLocalAgent?: boolean;
	model?: string;
	apiKey?: string;
	onProgress?: (event: MetampSubagentProgressEvent) => void;
}

export interface MetampSubagentRunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
}

export interface ParsedSubagentEvent {
	role?: string;
	text?: string;
	error?: string;
}

export type { MetampSubagentProgressEvent, MetampSubagentProgressKind } from "./progress.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	let event: unknown;
	try {
		event = JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
	return isRecord(event) ? event : undefined;
}

function messageText(message: Record<string, unknown>): string | undefined {
	const maybeContent = message.content;
	const parts: string[] = [];
	if (Array.isArray(maybeContent)) {
		for (const part of maybeContent) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function joinNonEmpty(parts: readonly string[], separator = "\n"): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join(separator);
}

export function getHarnessInvocation(args: string[]): { command: string; args: string[] } {
	const runnerDir = path.dirname(fileURLToPath(import.meta.url));
	const sourceHarness = path.resolve(runnerDir, "../../../coding-agent/src/cli.ts");
	if (existsSync(sourceHarness)) return { command: process.execPath, args: [sourceHarness, ...args] };
	const distHarness = path.resolve(runnerDir, "../../../coding-agent/dist/cli.js");
	if (existsSync(distHarness)) return { command: process.execPath, args: [distHarness, ...args] };
	return { command: "metamp-harness", args };
}

function getExtensionPath(): string | undefined {
	const runnerDir = path.dirname(fileURLToPath(import.meta.url));
	const sourceExtension = path.resolve(runnerDir, "../extension.ts");
	if (existsSync(sourceExtension)) return sourceExtension;
	const distExtension = path.resolve(runnerDir, "../extension.js");
	if (existsSync(distExtension)) return distExtension;
	return undefined;
}

export function parseSubagentJsonLine(line: string): ParsedSubagentEvent | undefined {
	const event = parseJsonLine(line);
	if (!event) return undefined;
	const maybeMessage = event.message;
	if (!isRecord(maybeMessage)) return undefined;
	return {
		role: stringField(maybeMessage, "role"),
		text: messageText(maybeMessage),
		error: stringField(maybeMessage, "errorMessage"),
	};
}

function isCompletionReceipt(line: string): boolean {
	return /^(?:done|completed|complete|task completed|analysis completed|subagent completed|i have completed.*|i've completed.*)$/i.test(
		line.trim(),
	);
}

export function cleanSubagentOutput(output: string): string {
	const trimmed = output.trim();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	while (lines.length > 0 && isCompletionReceipt(lines[0])) lines.shift();
	while (lines.length > 0 && isCompletionReceipt(lines[lines.length - 1])) lines.pop();
	return lines.join("\n").trim();
}

export function parseSubagentProgressLine(line: string): MetampSubagentProgressEvent | undefined {
	const event = parseJsonLine(line);
	if (!event) return undefined;
	const eventType = stringField(event, "type");
	if (eventType === "agent_start") return { type: "started", text: "agent started" };
	if (eventType === "turn_start") return { type: "status", text: "turn started" };
	if (eventType === "message_start") {
		const message = event.message;
		if (isRecord(message) && message.role === "assistant") return { type: "status", text: "assistant responding" };
	}
	if (eventType === "message_update") {
		const assistantEvent = event.assistantMessageEvent;
		if (!isRecord(assistantEvent)) return undefined;
		const assistantEventType = stringField(assistantEvent, "type");
		if (assistantEventType === "thinking_delta") {
			const delta = stringField(assistantEvent, "delta");
			return delta ? { type: "thinking", text: delta } : undefined;
		}
		if (assistantEventType === "text_delta") {
			const delta = stringField(assistantEvent, "delta");
			return delta ? { type: "text", text: delta } : undefined;
		}
		if (assistantEventType === "toolcall_end") {
			const toolCall = assistantEvent.toolCall;
			const toolName = isRecord(toolCall) ? stringField(toolCall, "name") : undefined;
			return { type: "tool_finished", text: `tool call: ${toolName ?? "unknown"}`, toolName };
		}
		if (assistantEventType === "error") return { type: "error", text: "assistant stream error" };
	}
	if (eventType === "tool_execution_start") {
		const toolName = stringField(event, "toolName");
		return { type: "tool_started", text: `tool started: ${toolName ?? "unknown"}`, toolName };
	}
	if (eventType === "tool_execution_update") {
		const toolName = stringField(event, "toolName");
		return { type: "tool_update", text: `tool update: ${toolName ?? "unknown"}`, toolName };
	}
	if (eventType === "tool_execution_end") {
		const toolName = stringField(event, "toolName");
		const label = event.isError === true ? "tool failed" : "tool finished";
		return { type: "tool_finished", text: `${label}: ${toolName ?? "unknown"}`, toolName };
	}
	if (eventType === "message_end") {
		const message = event.message;
		if (isRecord(message) && message.role === "assistant") {
			const error = stringField(message, "errorMessage");
			if (error) return { type: "error", text: error };
		}
	}
	return undefined;
}

export async function buildMetampSubagentPrompt(
	projectRoot: string,
	agent: DiscoveredMetampAgentSpec,
): Promise<string> {
	const state = await loadProjectState(projectRoot);
	return `${agent.prompt}

${generatePolicyPromptBlock(agent)}

Metamp project state:
${formatProjectState(state)}

Rules:
- Treat .metamp manifests as source of truth.
- Use owned Metamp domain tools for durable manifests and reports.
- For cross-ownership writes or material decisions outside your authority, create an approval request.
- Return concise, structured findings for the parent copilot or user.
- Do not include acknowledgements, acceptance phrases, completion receipts, or meta commentary such as "done", "completed", or "I will".`;
}

export async function runMetampSubagent(input: MetampSubagentRunInput): Promise<MetampSubagentRunResult> {
	const agent = await findMetampAgentSpec(input.agentName, { projectRoot: input.projectRoot });
	if (!agent) {
		const available = (await discoverMetampSubagents({ projectRoot: input.projectRoot }))
			.map((item) => item.name)
			.join(", ");
		throw new Error(`Unknown Metamp subagent ${input.agentName}. Available agents: ${available}`);
	}
	if (agent.source === "project" && !input.allowProjectLocalAgent) {
		throw new Error(`Project-local Metamp subagent ${agent.name} requires explicit confirmation before execution`);
	}
	const tmpDir = await mkdtemp(path.join(tmpdir(), "metamp-subagent-"));
	const promptPath = path.join(tmpDir, `${agent.name}.md`);
	let stderr = "";
	let assistantError = "";
	const assistantOutputs: string[] = [];
	try {
		await writeFile(promptPath, await buildMetampSubagentPrompt(input.projectRoot, agent), {
			encoding: "utf8",
			mode: 0o600,
		});
		const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath];
		const extensionPath = getExtensionPath();
		if (extensionPath) args.push("--extension", extensionPath);
		const model = agent.model ?? input.model;
		if (model) args.push("--model", model);
		if (input.apiKey) args.push("--api-key", input.apiKey);
		if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
		args.push(`Task for ${agent.name}: ${input.task}`);
		const invocation = getHarnessInvocation(args);
		const exitCode = await new Promise<number>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: input.cwd ?? input.projectRoot,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let aborted = false;
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;
			let buffer = "";
			const emitProgress = (event: MetampSubagentProgressEvent) => input.onProgress?.(event);
			const cleanup = () => {
				if (killTimer) clearTimeout(killTimer);
				input.signal?.removeEventListener("abort", abort);
			};
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(code);
			};
			const processLine = (line: string) => {
				const progress = parseSubagentProgressLine(line);
				if (progress) emitProgress(progress);
				const event = parseJsonLine(line);
				if (!event || stringField(event, "type") !== "message_end") return;
				const message = event.message;
				if (!isRecord(message) || message.role !== "assistant") return;
				const text = messageText(message);
				if (text) assistantOutputs.push(text);
				const error = stringField(message, "errorMessage");
				if (error) {
					assistantError = joinNonEmpty([assistantError, error]);
					emitProgress({ type: "error", text: error });
				}
			};
			const abort = () => {
				aborted = true;
				emitProgress({ type: "aborted", text: "subagent abort requested", exitCode: ABORT_EXIT_CODE });
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					child.kill("SIGKILL");
				}, ABORT_KILL_DELAY_MS);
				killTimer.unref?.();
			};
			emitProgress({ type: "started", text: `starting ${agent.name}` });
			if (input.signal?.aborted) abort();
			else input.signal?.addEventListener("abort", abort, { once: true });
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				const normalizedCode = aborted ? ABORT_EXIT_CODE : (code ?? 0);
				const finalCode = normalizedCode === 0 && assistantError ? 1 : normalizedCode;
				if (aborted) emitProgress({ type: "aborted", text: "subagent aborted", exitCode: finalCode });
				else if (finalCode === 0)
					emitProgress({ type: "completed", text: "subagent completed", exitCode: finalCode });
				else
					emitProgress({
						type: "error",
						text: assistantError || `subagent exited with code ${finalCode}`,
						exitCode: finalCode,
					});
				finish(finalCode);
			});
			child.on("error", (error) => {
				stderr = joinNonEmpty([stderr, error.message]);
				emitProgress({ type: "error", text: error.message });
				finish(1);
			});
		});
		const output = cleanSubagentOutput(assistantOutputs.join("\n\n"));
		return {
			agent: agent.name,
			task: input.task,
			exitCode,
			output: output || (exitCode === ABORT_EXIT_CODE ? "Subagent aborted." : ""),
			stderr: joinNonEmpty([stderr, assistantError]),
		};
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

export function subagentTextResult(result: MetampSubagentRunResult): AgentToolResult<MetampSubagentRunResult> {
	return {
		content: [
			{
				type: "text",
				text:
					result.exitCode === 0
						? result.output || "(no output)"
						: result.stderr || result.output || "subagent failed",
			},
		],
		details: result,
	};
}
