import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const VENV_DIR = ".venv";

export interface ProjectPythonEnvPaths {
	venvDir: string;
	pythonPath: string;
	relativePythonPath: string;
}

interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

function pythonPathParts(): string[] {
	return process.platform === "win32" ? [VENV_DIR, "Scripts", "python.exe"] : [VENV_DIR, "bin", "python"];
}

function processOutput(result: ProcessResult): string {
	return `${result.stdout}${result.stderr}`.trim();
}

async function runProcess(command: string, args: string[], cwd?: string): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			resolve({ stdout, stderr, exitCode });
		});
	});
}

export function getPythonEnvPaths(root: string): ProjectPythonEnvPaths {
	const parts = pythonPathParts();
	return {
		venvDir: path.join(root, VENV_DIR),
		pythonPath: path.join(root, ...parts),
		relativePythonPath: parts.join("/"),
	};
}

export async function createProjectPythonEnv(root: string): Promise<ProjectPythonEnvPaths> {
	let result: ProcessResult;
	try {
		result = await runProcess("python3", ["-m", "venv", VENV_DIR], root);
	} catch (error) {
		throw new Error(
			`Failed to create project Python environment at ${VENV_DIR}. Install Python 3 with venv support, then run \`python3 -m venv .venv\` from the project root. Cause: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (result.exitCode !== 0) {
		const output = processOutput(result);
		throw new Error(
			`Failed to create project Python environment at ${VENV_DIR} with \`python3 -m venv .venv\`.${output ? `\n${output}` : ""}`,
		);
	}

	return assertProjectPythonEnv(root);
}

export async function assertProjectPythonEnv(root: string): Promise<ProjectPythonEnvPaths> {
	const paths = getPythonEnvPaths(root);
	try {
		const stats = await stat(paths.pythonPath);
		if (!stats.isFile()) {
			throw new Error(`${paths.relativePythonPath} is not a file`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`Project Python environment is missing at ${paths.relativePythonPath}. Run \`python3 -m venv .venv\` from the project root.`,
			);
		}
		throw error;
	}
	return paths;
}

export async function getPythonVersion(pythonPath: string): Promise<string | undefined> {
	const result = await runProcess(pythonPath, ["--version"]);
	if (result.exitCode !== 0) {
		const output = processOutput(result);
		throw new Error(`Failed to read Python version from ${pythonPath}.${output ? `\n${output}` : ""}`);
	}
	return processOutput(result) || undefined;
}
