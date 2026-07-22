import { describe, expect, test } from "vitest";
import { summarizeBashCommand } from "../src/core/tools/bash-command-summary.ts";

describe("summarizeBashCommand", () => {
	test("returns unique command names in first-seen order", () => {
		expect(
			summarizeBashCommand("find . -name '*.ts' && gh run list && git status && git log -1 && git diff --cached"),
		).toEqual(["find", "gh", "git"]);
	});

	test("deduplicates repeated command kinds", () => {
		expect(summarizeBashCommand("git add . && git diff --cached && git commit -m done")).toEqual(["git"]);
	});

	test("supports pipelines, newlines, and leading assignments", () => {
		expect(summarizeBashCommand("CI=true npm run check | sort\ngit status")).toEqual(["npm", "sort", "git"]);
	});

	test("does not split separators inside quotes or escaped find expressions", () => {
		expect(
			summarizeBashCommand("git commit -m 'fix && docs' && find . -exec grep foo {} \\; && gh run list"),
		).toEqual(["git", "find", "gh"]);
	});

	test("normalizes absolute executable paths and Windows suffixes", () => {
		expect(summarizeBashCommand("/usr/bin/git.exe status && git.exe log -1")).toEqual(["git"]);
	});

	test("accepts connector line continuations and trailing newlines", () => {
		expect(summarizeBashCommand("git status &&\n  gh run list\n")).toEqual(["git", "gh"]);
	});

	test("returns undefined for a single command", () => {
		expect(summarizeBashCommand("git status --short")).toBeUndefined();
	});

	test("returns undefined for an incomplete command chain", () => {
		expect(summarizeBashCommand("git status && gh run list &&")).toBeUndefined();
	});

	test("returns undefined when a command is not in the safe summary set", () => {
		expect(summarizeBashCommand("git status && ./scripts/release.sh")).toBeUndefined();
		expect(summarizeBashCommand("node scripts/release.js && git status")).toBeUndefined();
	});

	test("returns undefined for unsupported shell syntax", () => {
		expect(summarizeBashCommand("git status && echo $(git rev-parse HEAD)")).toBeUndefined();
		expect(summarizeBashCommand("if git status; then gh run list; fi")).toBeUndefined();
	});
});
