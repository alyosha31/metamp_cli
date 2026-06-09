import { describe, expect, it } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("does not call the upstream pi update endpoint", async () => {
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBeUndefined();
		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});
});
