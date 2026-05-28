import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initProject } from "../src/project/init.ts";
import { discoverMetampSubagents, findMetampAgentSpec } from "../src/subagents/discovery.ts";

async function tempRoot(prefix: string): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeAgent(filePath: string, body: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, body, "utf8");
}

describe("Metamp subagent discovery", () => {
	it("discovers bundled, user, and project agents with project precedence", async () => {
		const userHome = await tempRoot("metamp-user-agents-");
		const cwd = await tempRoot("metamp-project-agents-");
		const project = await initProject("custom", cwd);
		await writeAgent(
			path.join(userHome, ".metamp", "agent", "agents", "pricing-analyst.md"),
			`---
name: pricing-analyst
description: User pricing analyst.
owns:
  manifests:
    - custom.pricing
  reports:
    - reports/pricing/
tools:
  - read_project_state
  - write_owned_report
decisions:
  target: propose
---
User prompt.
`,
		);
		await writeAgent(
			path.join(project.root, ".metamp", "agents", "pricing-analyst.md"),
			`---
name: pricing-analyst
description: Project pricing analyst.
owns:
  manifests:
    - custom.pricing
  reports:
    - reports/pricing/
  recipes:
    - recipes/pricing/
  artifacts:
    - artifacts/pricing/
tools:
  - read_project_state
  - update_owned_manifest
  - write_owned_report
decisions:
  metric: propose
---
Project prompt.
`,
		);

		const agents = await discoverMetampSubagents({ projectRoot: project.root, userHome });
		const pricing = agents.find((agent) => agent.name === "pricing-analyst");

		expect(agents.some((agent) => agent.name === "schema-detective")).toBe(true);
		expect(pricing?.source).toBe("project");
		expect(pricing?.requiresConfirmation).toBe(true);
		expect(pricing?.description).toBe("Project pricing analyst.");
		expect(pricing?.owns.manifests).toEqual(["custom.pricing"]);
		expect(pricing?.tools).toContain("metamp_update_owned_manifest");
	});

	it("finds project-local agents and marks them confirmation-gated", async () => {
		const cwd = await tempRoot("metamp-project-agent-");
		const project = await initProject("confirm", cwd);
		await writeAgent(
			path.join(project.root, ".metamp", "agents", "risk-reviewer.md"),
			`---
name: risk-reviewer
description: Reviews risk-sensitive model behavior.
owns:
  manifests:
    - custom.risk
  reports:
    - reports/risk/
tools:
  - read_project_state
decisions:
  leakage: propose
---
Risk prompt.
`,
		);

		const agent = await findMetampAgentSpec("risk-reviewer", {
			projectRoot: project.root,
			userHome: await tempRoot("empty-home-"),
		});

		expect(agent?.source).toBe("project");
		expect(agent?.requiresConfirmation).toBe(true);
	});

	it("rejects unsafe custom ownership", async () => {
		const cwd = await tempRoot("metamp-bad-agent-");
		const project = await initProject("bad", cwd);
		await writeAgent(
			path.join(project.root, ".metamp", "agents", "bad.md"),
			`---
name: bad-agent
description: Invalid ownership.
owns:
  manifests:
    - decisions
  reports:
    - ../escape/
tools:
  - read_project_state
---
Bad prompt.
`,
		);

		await expect(
			discoverMetampSubagents({ projectRoot: project.root, userHome: await tempRoot("empty-home-") }),
		).rejects.toThrow("protected manifest");
	});
});
