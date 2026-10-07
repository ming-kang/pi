import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

import type { ChatMessage } from "../src/extensions/search/client.ts";
import { PathSandbox } from "../src/extensions/search/sandbox.ts";
import { formatSearchResult, parseAnswer, type SearchResult, trimMessages } from "../src/extensions/search/search.ts";

const root = mkdtempSync(join(tmpdir(), "fc-search-selftest-"));
writeFileSync(join(root, "a.ts"), "export {};\n");
const sandbox = new PathSandbox(root);

{
	const xml = `<ANSWER>
  <file path="/codebase/a.ts">
    <range>10-60</range>
    <range>80-90</range>
  </file>
</ANSWER>`;
	const files = parseAnswer(xml, sandbox);
	assert.equal(files.length, 1, "one file parsed");
	assert.equal(files[0]!.path, "a.ts", "virtual prefix stripped from rel path");
	assert.equal(files[0]!.fullPath, join(sandbox.realRoot, "a.ts"), "fullPath maps under the real root");
	assert.deepEqual(
		files[0]!.ranges,
		[
			[10, 60],
			[80, 90],
		],
		"ranges parsed",
	);
}

assert.equal(
	parseAnswer("<file path='/codebase/a.ts'><range>1-2</range></file>", sandbox).length,
	1,
	"single-quote attr",
);

{
	const evil = `<file path="/codebase/../../etc/passwd"><range>1-2</range></file>
<file path="/etc/passwd"><range>1-2</range></file>
<file path="C:\\Windows\\system32\\config"><range>1-2</range></file>
<file path="/codebase/a.ts"><range>1-1</range></file>`;
	const files = parseAnswer(evil, sandbox);
	assert.equal(files.length, 1, "escape/absolute paths refused, in-root survivor kept");
	assert.equal(files[0]!.path, "a.ts");
}

assert.equal(parseAnswer("no xml at all", sandbox).length, 0, "non-XML -> empty");

function bigUser(query: string): ChatMessage {
	return { role: 1, content: `Problem Statement: ${query}\n\nRepo Map (tree -L 3 /codebase):\n${"x".repeat(5000)}` };
}
function callPair(id: string, content: string): ChatMessage[] {
	return [
		{ role: 2, content: `thinking ${id}`, tool_call_id: id, tool_name: "restricted_exec", tool_args_json: "{}" },
		{ role: 4, content, ref_call_id: id },
	];
}

{
	const messages: ChatMessage[] = [
		{ role: 5, content: "system" },
		bigUser("find the auth flow"),
		...callPair("c1", "old results"),
		...callPair("c2", "recent results"),
	];
	const shrunk = trimMessages(messages, "find the auth flow");
	assert.ok(shrunk, "trim reports success");
	assert.equal(messages[0]!.content, "system", "system message preserved first");
	assert.ok(messages[1]!.content.includes("omitted"), "repo map compacted away");
	const call = messages.find((m) => m.role === 2 && m.tool_call_id === "c2");
	const result = messages.find((m) => m.role === 4 && m.ref_call_id === "c2");
	assert.ok(call && result, "latest call/result pair intact");
	assert.ok(!messages.some((m) => m.ref_call_id === "c1"), "older result dropped");
}

{
	const messages: ChatMessage[] = [
		{ role: 5, content: "system" },
		{ role: 1, content: "Problem Statement: q" },
	];
	assert.equal(trimMessages(messages, "q"), false, "already-minimal conversation refuses to trim");
	assert.equal(trimMessages([], "q"), false, "empty conversation refuses to trim");
}

const FMT = { maxTurns: 3, maxResults: 10, maxCommands: 8, timeoutMs: 30000, excludePaths: ["gen"] };

{
	const result: SearchResult = {
		files: [
			{ path: "a.ts", fullPath: "/repo/a.ts", ranges: [[1, 10]] },
			{ path: "b.ts", fullPath: "/repo/b.ts", ranges: [] },
		],
		rgPatterns: ["authFlow", "ok", "authFlow"],
		meta: { treeDepth: 3, treeSizeKB: 12.5, fellBack: true, strategy: "hotspot", hotDirs: ["src"], hotspotDepth: 2 },
	};
	const text = formatSearchResult(result, FMT);
	assert.ok(text.includes("Found 2 relevant files."), "count line");
	assert.ok(text.includes("[1/2] /repo/a.ts (L1-10)"), "numbered file with ranges");
	assert.ok(text.includes("[2/2] /repo/b.ts") && !text.includes("/repo/b.ts ("), "rangeless file has no parens");
	assert.ok(text.includes("grep keywords: authFlow"), "rg patterns deduped");
	assert.ok(!text.includes(" ok"), "short patterns (<3 chars) filtered");
	assert.ok(text.includes("(fell back from requested depth)"), "fallback noted");
	assert.ok(text.includes("strategy=hotspot, hotspot_depth=2, hot=[src]"), "meta config line");
	assert.ok(text.includes("exclude_paths=[gen]"), "exclude paths echoed");
}

{
	const text = formatSearchResult(
		{
			files: [],
			error: "PAYLOAD_TOO_LARGE: too big",
			meta: { treeDepth: 4, treeSizeKB: 300, fellBack: false, errorCode: "PAYLOAD_TOO_LARGE" },
		},
		FMT,
	);
	assert.ok(text.startsWith("Error: PAYLOAD_TOO_LARGE"), "error line first");
	assert.ok(text.includes("[diagnostic] error_type=PAYLOAD_TOO_LARGE"), "diagnostic present");
	assert.ok(text.includes("reduce tree_depth"), "payload hint attached");
}

assert.equal(formatSearchResult({ files: [] }, FMT), "No relevant files found.", "empty result message");
assert.ok(
	formatSearchResult({ files: [], rawResponse: "the model rambled" }, FMT).includes(
		"Raw response:\nthe model rambled",
	),
	"raw response surfaced when no files",
);

{
	const text = formatSearchResult({ files: [], rawResponse: "r".repeat(5000) }, FMT);
	assert.ok(text.length < 2600, "long raw response bounded");
	assert.ok(text.includes("[raw response truncated: 5000 chars total]"), "truncation notice present");
}

console.log("OK search self-test passed");

describe("search search selftest", async () => {
	it("passes", async () => {});
});
