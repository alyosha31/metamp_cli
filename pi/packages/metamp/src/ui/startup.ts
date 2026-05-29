import { discoverMetampSubagents } from "../subagents/discovery.ts";

const METAMP_LOGO_LINES = [
	"▗▖  ▗▖ ▗▄▄▄▖▗▄▄▄▖ ▗▄▖ ▗▖  ▗▖▗▄▄▖",
	"▐▛▚▞▜▌ ▐▌    █  ▐▌ ▐▌▐▛▚▞▜▌▐▌ ▐▌",
	"▐▌  ▐▌ ▐▛▀   █  ▐▛▀▜▌▐▌  ▐▌▐▛▀▘",
	"▐▌  ▐▌ ▐▙▄▄▖ █  ▐▌ ▐▌▐▌  ▐▌▐▌",
] as const;

const METAMP_HINT_LINE = "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more";
const WIDGET_TITLE = "metamp · ML copilot workbench";
const SPECIALIST_PREFIX = "specialists: ";
interface RenderTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}

export interface MetampStartupChromeState {
	projectSummary?: string;
	specialistCommands: readonly string[];
}

export const METAMP_STARTUP_PROFILE = {
	name: "metamp",
	title: "Metamp",
	tagline: "ML copilot workbench",
	helpText:
		"Metamp can explain its own features and inspect .metamp manifests. Ask it to inspect, propose, or record ML decisions.",
	logoLines: METAMP_LOGO_LINES,
	disableUpdateNotices: true,
} as const;

function clipText(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function formatSpecialistSummary(commands: readonly string[], width: number): string {
	if (commands.length === 0) return `${SPECIALIST_PREFIX}none`;
	const normalizedWidth = Math.max(SPECIALIST_PREFIX.length + 4, width);
	let result = SPECIALIST_PREFIX;
	let shown = 0;
	for (let index = 0; index < commands.length; index += 1) {
		const command = commands[index];
		const separator = shown === 0 ? "" : " · ";
		const candidate = `${result}${separator}${command}`;
		const remaining = commands.length - index - 1;
		if (remaining === 0) {
			return clipText(candidate, normalizedWidth);
		}
		const withMore = `${candidate} · +${remaining} more`;
		if (withMore.length <= normalizedWidth) {
			result = candidate;
			shown = index + 1;
			continue;
		}
		if (shown === 0) return clipText(`${SPECIALIST_PREFIX}${command}`, normalizedWidth);
		return clipText(`${result} · +${commands.length - shown} more`, normalizedWidth);
	}
	return clipText(result, normalizedWidth);
}

export async function buildSpecialistCommandList(projectRoot?: string): Promise<readonly string[]> {
	const agents = await discoverMetampSubagents(projectRoot ? { projectRoot } : {});
	return agents.map((agent) => `/${agent.name}`);
}
export function renderMetampHeaderLines(theme: RenderTheme, width: number, state: MetampStartupChromeState): string[] {
	const accent = (text: string) => theme.bold(theme.fg("accent", text));
	const muted = (text: string) => theme.fg("muted", text);
	const dim = (text: string) => theme.fg("dim", text);
	const usableWidth = Math.max(24, width);
	const lines = [
		"",
		...METAMP_LOGO_LINES.map((line) => accent(line)),
		`${accent(METAMP_STARTUP_PROFILE.name)} ${muted(METAMP_STARTUP_PROFILE.tagline)}`,
		dim(clipText(METAMP_HINT_LINE, usableWidth)),
	];
	if (state.projectSummary) {
		lines.push(dim(clipText(`project: ${state.projectSummary}`, usableWidth)));
	}
	lines.push(dim(formatSpecialistSummary(state.specialistCommands, usableWidth)), "");
	return lines;
}

export function renderMetampWidgetLines(width: number, state: MetampStartupChromeState): string[] {
	const usableWidth = Math.max(24, width);
	const title = state.projectSummary ? `metamp · ${state.projectSummary}` : WIDGET_TITLE;
	return [clipText(title, usableWidth), formatSpecialistSummary(state.specialistCommands, usableWidth)];
}
