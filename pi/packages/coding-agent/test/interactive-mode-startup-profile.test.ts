import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { resolveStartupProductProfile } from "../src/modes/interactive/startup-product-profile.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode startup product profile", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("uses startup profile title for the terminal title", () => {
		const setTitle = vi.fn();
		const fakeThis: any = {
			startupProductProfile: resolveStartupProductProfile({
				name: "metamp",
				title: "Metamp",
				tagline: "ML copilot workbench",
				helpText: "Analyze manifests.",
			}),
			sessionManager: {
				getCwd: () => "/tmp/project",
				getSessionName: () => "session-a",
			},
			ui: {
				terminal: {
					setTitle,
				},
			},
		};

		(InteractiveMode as any).prototype.updateTerminalTitle.call(fakeThis);

		expect(setTitle).toHaveBeenCalledWith("Metamp - session-a - project");
	});

	test("suppresses version update notifications when disabled by the startup profile", () => {
		const fakeThis: any = {
			startupProductProfile: resolveStartupProductProfile({
				name: "metamp",
				title: "Metamp",
				tagline: "ML copilot workbench",
				helpText: "Analyze manifests.",
				disableUpdateNotices: true,
			}),
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: vi.fn(),
		};

		(InteractiveMode as any).prototype.showNewVersionNotification.call(fakeThis, {
			version: "9.9.9",
			note: "new",
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});

	test("suppresses package update notifications when disabled by the startup profile", () => {
		const fakeThis: any = {
			startupProductProfile: resolveStartupProductProfile({
				name: "metamp",
				title: "Metamp",
				tagline: "ML copilot workbench",
				helpText: "Analyze manifests.",
				disableUpdateNotices: true,
			}),
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.showPackageUpdateNotification.call(fakeThis, ["package-a"]);

		expect(fakeThis.chatContainer.children).toHaveLength(0);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});
