import { describe, expect, test } from "vitest";
import {
	buildIsolatedPath,
	findMissingRequiredTools,
	getManagedBinDirectory,
} from "../scripts/test-isolated.mjs";

describe("isolated test runner helpers", () => {
	test("prefers an existing configured Pi bin and falls back to the real home", () => {
		const configured = getManagedBinDirectory(
			{ PI_CODING_AGENT_DIR: "C:\\custom-agent", USERPROFILE: "C:\\Users\\Example" },
			"win32",
			(path) => path === "C:\\custom-agent\\bin",
		);
		expect(configured).toBe("C:\\custom-agent\\bin");

		const fallback = getManagedBinDirectory(
			{ PI_CODING_AGENT_DIR: "C:\\missing", USERPROFILE: "C:\\Users\\Example" },
			"win32",
			(path) => path === "C:\\Users\\Example\\.pi\\agent\\bin",
		);
		expect(fallback).toBe("C:\\Users\\Example\\.pi\\agent\\bin");
	});

	test("prepends managed tools, removes WindowsApps, and deduplicates Windows paths", () => {
		const path = buildIsolatedPath(
			"C:\\WindowsApps;C:\\Tools;C:\\Users\\Example\\.pi\\agent\\bin",
			"c:/users/example/.pi/agent/bin",
			"win32",
		);
		expect(path).toBe("c:/users/example/.pi/agent/bin;C:\\Tools");
	});

	test("keeps POSIX entries unchanged apart from prepending the managed bin", () => {
		expect(buildIsolatedPath("/usr/bin:/opt/WindowsApps", "/home/example/.pi/agent/bin", "linux")).toBe(
			"/home/example/.pi/agent/bin:/usr/bin:/opt/WindowsApps",
		);
	});

	test("accepts fdfind as the fd command and reports missing tools once", () => {
		const available = new Set(["fdfind", "rg"]);
		expect(findMissingRequiredTools((command) => available.has(command))).toEqual([]);
		expect(findMissingRequiredTools(() => false)).toEqual(["fd (or fdfind)", "rg"]);
	});
});
