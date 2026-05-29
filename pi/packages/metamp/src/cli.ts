#!/usr/bin/env node
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { main as piMain } from "@earendil-works/pi-coding-agent";
import { LocalPythonExecutionBackend } from "./execution/local-python.ts";
import { createMetampExtension } from "./extension.ts";
import { registerDataset } from "./project/datasets.ts";
import { initProject } from "./project/init.ts";
import { findProjectRoot, requireProjectRoot } from "./project/paths.ts";
import { getPythonEnvPaths } from "./project/python-env.ts";
import { formatProjectState, loadProjectState } from "./project/state.ts";
import { listRuns, promoteRun } from "./runs/run-store.ts";
import { METAMP_STARTUP_PROFILE } from "./ui/startup.ts";

function printHelp(): void {
	console.log(`metamp - ML copilot workbench

Usage:
  metamp init <project-name|.>
  metamp add-data <path> [--copy|--link]
  metamp copilot [--model provider/model]
  metamp run <recipe>
  metamp runs [--json]
  metamp promote <run-id>
  metamp status [--json]
`);
}
async function confirmPrompt(message: string): Promise<boolean> {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(`${message} [y/N] `);
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

function printGettingStarted(): void {
	console.log(`Metamp project not found.

Getting started:
  metamp init <name>
  cd <name>
  metamp add-data <path>
  metamp copilot

Run metamp --help for all commands.`);
}

function parseFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function parseStringFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

async function statusCommand(json: boolean): Promise<void> {
	const root = await requireProjectRoot(process.cwd());
	const state = await loadProjectState(root);
	if (json) {
		console.log(JSON.stringify(state, null, 2));
		return;
	}
	console.log(formatProjectState(state));
}

async function initCommand(args: string[]): Promise<void> {
	const name = args[0];
	if (!name) throw new Error("Usage: metamp init <project-name|.>");
	const result = await initProject(name, process.cwd());
	const python = getPythonEnvPaths(result.root);
	console.log(`Initialized Metamp project: ${result.project.name}`);
	console.log("created .venv");
	if (name !== ".") console.log(`cd ${path.relative(process.cwd(), result.root) || "."}`);
	console.log(`${python.relativePythonPath} -m pip install <packages>`);
	console.log("metamp add-data <path>");
	console.log("metamp copilot");
}

async function addDataCommand(args: string[]): Promise<void> {
	const target = args.find((arg) => !arg.startsWith("--"));
	if (!target) throw new Error("Usage: metamp add-data <path> [--copy|--link]");
	if (parseFlag(args, "--copy") && parseFlag(args, "--link")) throw new Error("Use only one of --copy or --link");
	const root = await requireProjectRoot(process.cwd());
	const mode = parseFlag(args, "--link") ? "link" : "copy";
	const result = await registerDataset(root, target, { mode });
	console.log(`Registered ${result.dataset.id}: ${result.dataset.storedPath}`);
	if (result.dataset.columns.length > 0) {
		console.log(`Columns: ${result.dataset.columns.map((column) => column.name).join(", ")}`);
	}
	if (result.warning) console.warn(`Warning: ${result.warning}`);
}

async function copilotCommand(args: string[]): Promise<void> {
	const root = await requireProjectRoot(process.cwd());
	const model = parseStringFlag(args, "--model");
	process.chdir(root);
	process.env.METAMP_OFFLINE = "1";
	process.env.METAMP_SKIP_VERSION_CHECK = "1";
	const piArgs = ["--offline"];
	if (model) piArgs.push("--model", model);
	const mainOptions = {
		extensionFactories: [createMetampExtension({ projectRoot: root })],
		startupProfile: METAMP_STARTUP_PROFILE,
	} as Parameters<typeof piMain>[1];
	await piMain(piArgs, mainOptions);
}

async function runCommand(args: string[]): Promise<void> {
	const recipe = args[0];
	if (!recipe) throw new Error("Usage: metamp run <recipe>");
	const root = await requireProjectRoot(process.cwd());
	const backend = new LocalPythonExecutionBackend();
	const result = await backend.runRecipe({ projectRoot: root, recipePath: recipe });
	console.log(`${result.manifest.runId}: ${result.manifest.status}`);
	if (Object.keys(result.manifest.metrics).length > 0) {
		console.log(`Metrics: ${JSON.stringify(result.manifest.metrics)}`);
	}
	if (result.manifest.error) console.error(result.manifest.error);
	if (result.manifest.status !== "succeeded") process.exitCode = 1;
}

async function runsCommand(args: string[]): Promise<void> {
	const root = await requireProjectRoot(process.cwd());
	const runs = await listRuns(root);
	if (parseFlag(args, "--json")) {
		console.log(JSON.stringify(runs, null, 2));
		return;
	}
	const state = await loadProjectState(root);
	for (const run of runs) {
		const marker = state.project.promotedRunId === run.runId ? " *promoted" : "";
		const metrics = Object.keys(run.metrics).length > 0 ? ` metrics=${JSON.stringify(run.metrics)}` : "";
		console.log(`${run.runId} ${run.status} ${run.recipePath}${metrics}${marker}`);
	}
}

async function promoteCommand(args: string[]): Promise<void> {
	const runId = args[0];
	if (!runId) throw new Error("Usage: metamp promote <run-id>");
	const root = await requireProjectRoot(process.cwd());
	const state = await loadProjectState(root);
	if (state.project.promotedRunId && state.project.promotedRunId !== runId && process.stdin.isTTY) {
		const ok = await confirmPrompt(`Replace promoted run ${state.project.promotedRunId} with ${runId}?`);
		if (!ok) return;
	}
	await promoteRun(root, runId);
	console.log(`Promoted ${runId}`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	if (!command) {
		if (await findProjectRoot(process.cwd())) {
			await copilotCommand([]);
		} else {
			printGettingStarted();
		}
		return;
	}
	if (command === "--help" || command === "-h" || command === "help") {
		printHelp();
		return;
	}
	const rest = args.slice(1);
	switch (command) {
		case "init":
			await initCommand(rest);
			break;
		case "add-data":
			await addDataCommand(rest);
			break;
		case "copilot":
			await copilotCommand(rest);
			break;
		case "run":
			await runCommand(rest);
			break;
		case "runs":
			await runsCommand(rest);
			break;
		case "promote":
			await promoteCommand(rest);
			break;
		case "status":
			await statusCommand(parseFlag(rest, "--json"));
			break;
		default:
			throw new Error(`Unknown command ${command}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
