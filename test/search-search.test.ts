import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseAnswer } from "../src/extensions/search/answer.ts";
import type { ChatMessage } from "../src/extensions/search/client.ts";
import { trimMessages } from "../src/extensions/search/context.ts";
import { formatSearchResult } from "../src/extensions/search/format.ts";
import { PathSandbox } from "../src/extensions/search/sandbox.ts";
import type { SearchResult } from "../src/extensions/search/types.ts";

const root = mkdtempSync(join(tmpdir(), "fc-search-selftest-"));
writeFileSync(join(root, "a.ts"), "export {};\n");
const sandbox = new PathSandbox(root);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseAnswer", () => {
	it("parses a file with several ranges and strips the virtual prefix", () => {
		const xml = `<ANSWER>
  <file path="/codebase/a.ts">
    <range>10-60</range>
    <range>80-90</range>
  </file>
</ANSWER>`;
		const files = parseAnswer(xml, sandbox);
		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("a.ts");
		expect(files[0]!.fullPath).toBe(join(sandbox.realRoot, "a.ts"));
		expect(files[0]!.ranges).toEqual([
			[10, 60],
			[80, 90],
		]);
	});

	it("accepts a single-quoted path attribute", () => {
		expect(parseAnswer("<file path='/codebase/a.ts'><range>1-2</range></file>", sandbox)).toHaveLength(1);
	});

	it("drops escapes and absolute paths but keeps the in-root survivor", () => {
		const evil = `<file path="/codebase/../../etc/passwd"><range>1-2</range></file>
<file path="/etc/passwd"><range>1-2</range></file>
<file path="${String.raw`C:\Windows\system32\config`}"><range>1-2</range></file>
<file path="/codebase/a.ts"><range>1-1</range></file>`;
		const files = parseAnswer(evil, sandbox);
		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("a.ts");
	});

	it("returns nothing for text that is not an ANSWER document", () => {
		expect(parseAnswer("no xml at all", sandbox)).toHaveLength(0);
	});
});

function bigUser(query: string): ChatMessage {
	return { role: 1, content: `Problem Statement: ${query}\n\nRepo Map (tree -L 3 /codebase):\n${"x".repeat(5000)}` };
}

function callPair(id: string, content: string): ChatMessage[] {
	return [
		{ role: 2, content: `thinking ${id}`, tool_call_id: id, tool_name: "restricted_exec", tool_args_json: "{}" },
		{ role: 4, content, ref_call_id: id },
	];
}

describe("trimMessages", () => {
	it("drops the repo map and older exchanges but keeps the newest pair", () => {
		const messages: ChatMessage[] = [
			{ role: 5, content: "system" },
			bigUser("find the auth flow"),
			...callPair("c1", "old results"),
			...callPair("c2", "recent results"),
		];
		expect(trimMessages(messages, "find the auth flow")).toBe(true);
		expect(messages[0]!.content).toBe("system");
		expect(messages[1]!.content).toContain("omitted");
		expect(messages.find((m) => m.role === 2 && m.tool_call_id === "c2")).toBeDefined();
		expect(messages.find((m) => m.role === 4 && m.ref_call_id === "c2")).toBeDefined();
		expect(messages.some((m) => m.ref_call_id === "c1")).toBe(false);
	});

	it("refuses to trim an already-minimal conversation", () => {
		const messages: ChatMessage[] = [
			{ role: 5, content: "system" },
			{ role: 1, content: "Problem Statement: q" },
		];
		expect(trimMessages(messages, "q")).toBe(false);
		expect(trimMessages([], "q")).toBe(false);
	});
});

const FMT = { maxTurns: 3, maxResults: 10, maxCommands: 8, timeoutMs: 30000, excludePaths: ["gen"] };

describe("formatSearchResult", () => {
	it("renders the reading list, deduped keywords, and the config line", () => {
		const result: SearchResult = {
			files: [
				{ path: "a.ts", fullPath: "/repo/a.ts", ranges: [[1, 10]] },
				{ path: "b.ts", fullPath: "/repo/b.ts", ranges: [] },
			],
			rgPatterns: ["authFlow", "ok", "authFlow"],
			meta: {
				treeDepth: 3,
				treeSizeKB: 12.5,
				fellBack: true,
				strategy: "hotspot",
				hotDirs: ["src"],
				hotspotDepth: 2,
			},
		};
		const text = formatSearchResult(result, FMT);
		expect(text).toContain("Found 2 relevant files.");
		expect(text).toContain("[1/2] /repo/a.ts (L1-10)");
		expect(text).toContain("[2/2] /repo/b.ts");
		expect(text).not.toContain("/repo/b.ts (");
		expect(text).toContain("grep keywords: authFlow");
		expect(text).not.toContain(" ok");
		expect(text).toContain("(fell back from requested depth)");
		expect(text).toContain("strategy=hotspot, hotspot_depth=2, hot=[src]");
		expect(text).toContain("exclude_paths=[gen]");
	});

	it("leads an error with the code, then diagnostics, config, and a hint", () => {
		const text = formatSearchResult(
			{
				files: [],
				error: "PAYLOAD_TOO_LARGE: too big",
				meta: { treeDepth: 4, treeSizeKB: 300, fellBack: false, errorCode: "PAYLOAD_TOO_LARGE" },
			},
			FMT,
		);
		expect(text.startsWith("Error: PAYLOAD_TOO_LARGE")).toBe(true);
		expect(text).toContain("[diagnostic] error_type=PAYLOAD_TOO_LARGE");
		expect(text).toContain("reduce tree_depth");
	});

	it("says so plainly when nothing was found and there is no prose to show", () => {
		expect(formatSearchResult({ files: [] }, FMT)).toBe("No relevant files found.");
	});

	it("surfaces the raw response when the model produced no files", () => {
		expect(formatSearchResult({ files: [], rawResponse: "the model rambled" }, FMT)).toContain(
			"Raw response:\nthe model rambled",
		);
	});

	it("bounds a long raw response and says how much was dropped", () => {
		const text = formatSearchResult({ files: [], rawResponse: "r".repeat(5000) }, FMT);
		expect(text.length).toBeLessThan(2600);
		expect(text).toContain("[raw response truncated: 5000 chars total]");
	});
});
