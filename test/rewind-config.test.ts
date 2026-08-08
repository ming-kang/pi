import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const configRoot = vi.hoisted(() => `${process.cwd()}/.rewind-config-test`);

vi.mock("../src/extensions/rewind/paths.ts", () => ({
	rewindConfigPath: () => `${configRoot}/config.json`,
}));

import {
	loadRewindConfig,
	parseRetentionDays,
	reloadRewindConfig,
	saveRewindConfig,
} from "../src/extensions/rewind/config.ts";

describe("rewind retention input", () => {
	beforeEach(() => {
		rmSync(configRoot, { recursive: true, force: true });
		mkdirSync(configRoot, { recursive: true });
	});

	afterAll(() => {
		rmSync(configRoot, { recursive: true, force: true });
	});

	test.each([
		["0", 0],
		["30", 30],
		[" 3650 ", 3650],
	])("accepts %s", (input, expected) => {
		expect(parseRetentionDays(input)).toBe(expected);
	});

	test.each(["", "-1", "1.5", "30days", "3651", "1e2"])('rejects "%s"', (input) => {
		expect(parseRetentionDays(input)).toBeUndefined();
	});

	test("writes settings through a durable temporary file and rename", () => {
		expect(saveRewindConfig({ enabled: false, retentionDays: 14, maxSnapshots: 7 })).toBe(true);
		expect(existsSync(`${configRoot}/config.json`)).toBe(true);
		expect(JSON.parse(readFileSync(`${configRoot}/config.json`, "utf8"))).toEqual({
			enabled: false,
			retentionDays: 14,
			maxSnapshots: 7,
		});
		expect(readdirSync(configRoot).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(reloadRewindConfig()).toEqual({ enabled: false, retentionDays: 14, maxSnapshots: 7 });
		expect(loadRewindConfig()).toEqual({ enabled: false, retentionDays: 14, maxSnapshots: 7 });
	});
});
