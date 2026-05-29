import { APP_NAME, APP_TITLE } from "../../config.ts";

export interface StartupProductProfile {
	name: string;
	title: string;
	tagline: string;
	helpText: string;
	logoLines?: readonly string[];
	disableUpdateNotices?: boolean;
}

export interface ResolvedStartupProductProfile {
	name: string;
	title: string;
	tagline: string;
	helpText: string;
	logoLines: readonly string[];
	disableUpdateNotices: boolean;
}

const DEFAULT_LOGO_LINES = [
	"▗▖  ▗▖ ▗▄▄▄▖▗▄▄▄▖ ▗▄▖ ▗▖  ▗▖▗▄▄▖",
	"▐▛▚▞▜▌ ▐▌    █  ▐▌ ▐▌▐▛▚▞▜▌▐▌ ▐▌",
	"▐▌  ▐▌ ▐▛▀   █  ▐▛▀▜▌▐▌  ▐▌▐▛▀▘",
	"▐▌  ▐▌ ▐▙▄▄▖ █  ▐▌ ▐▌▐▌  ▐▌▐▌",
] as const;

const DEFAULT_PROFILE: ResolvedStartupProductProfile = {
	name: APP_NAME,
	title: APP_TITLE,
	tagline: "ml copilot workbench",
	helpText: `${APP_TITLE} can explain its own features and look up its docs. Ask it how to use or extend ${APP_TITLE}.`,
	logoLines: DEFAULT_LOGO_LINES,
	disableUpdateNotices: false,
};

export function resolveStartupProductProfile(profile?: StartupProductProfile): ResolvedStartupProductProfile {
	if (!profile) return DEFAULT_PROFILE;
	return {
		name: profile.name,
		title: profile.title,
		tagline: profile.tagline,
		helpText: profile.helpText,
		logoLines: profile.logoLines ?? DEFAULT_PROFILE.logoLines,
		disableUpdateNotices: profile.disableUpdateNotices ?? false,
	};
}
