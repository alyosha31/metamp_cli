import type { RunManifest } from "../manifests/schema.ts";

export interface RunRecipeInput {
	projectRoot: string;
	recipePath: string;
	inputs?: Record<string, unknown>;
	parentRunId?: string;
}

export interface RunRecipeResult {
	manifest: RunManifest;
	stdout: string;
	stderr: string;
}

export interface ExecutionBackend {
	readonly kind: string;
	runRecipe(input: RunRecipeInput, signal?: AbortSignal): Promise<RunRecipeResult>;
}
