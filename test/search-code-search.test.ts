import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { codeSearch, parseToolCall } from "../src/extensions/search/code-search.ts";
import { DevinAuthError, decodeChatResponse, webSearch } from "../src/extensions/search/devin.ts";
import { MAX_TURNS } from "../src/extensions/search/prompt.ts";
import { type CodeSearchDetails, renderCodeSearchResult } from "../src/extensions/search/render.ts";
import { Workspace } from "../src/extensions/search/workspace.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const root = mkdtempSync(join(tmpdir(), "search-code-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "retry.ts"), "export function retry() {\n  return 1;\n}\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

/** A Connect stream as Devin sends it: gzip data frames carrying text in field 2, then an end frame. */
function stream(text: string, end: object = {}): Response {
	const data = Buffer.from(text, "utf-8");
	const message = gzipSync(Buffer.concat([Buffer.from([0x12, ...varint(data.length)]), data]));
	const trailer = Buffer.from(JSON.stringify(end));
	const frame = (flags: number, body: Buffer) => {
		const head = Buffer.alloc(5);
		head[0] = flags;
		head.writeUInt32BE(body.length, 1);
		return Buffer.concat([head, body]);
	};
	return new Response(new Uint8Array(Buffer.concat([frame(1, message), frame(2, trailer)])));
}

function varint(n: number): number[] {
	const out: number[] = [];
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	return [...out, n];
}

/** Script Devin's replies and record every request body it receives. */
function devin(replies: string[]): string[] {
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = Buffer.from(init.body as Uint8Array);
			requests.push(gunzipSync(body.subarray(5)).toString("utf-8"));
			return stream(replies.shift() ?? "");
		}),
	);
	return requests;
}

const answer = (xml: string) => `Done.[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer: xml })}`;

describe("code_search loop", () => {
	it("runs the planner's commands locally and returns only answer paths inside the root", async () => {
		const requests = devin([
			// The malformed key quoting the live backend produces: `,start_line":1`.
			'Let me read.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/src/retry.ts",start_line":1}}</s>',
			answer(
				'<ANSWER><file path="/codebase/src/retry.ts"><range>1-3</range></file><file path="/codebase/../outside.ts"><range>1-2</range></file></ANSWER>',
			),
		]);
		const locations = await codeSearch({ apiKey: "k", query: "retry", root, cwd: root });
		expect(locations).toEqual([{ path: "src/retry.ts", ranges: [[1, 3]] }]);
		expect(requests[1]).toContain("1:export function retry() {");
	});

	it("demands an answer once the planning rounds run out", async () => {
		const call = '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase"}}';
		const requests = devin([...Array(MAX_TURNS).fill(call), answer("<ANSWER></ANSWER>")]);
		await expect(codeSearch({ apiKey: "k", query: "q", root, cwd: root })).resolves.toEqual([]);
		expect(requests).toHaveLength(MAX_TURNS + 1);
		expect(requests.at(-1)).toContain("You have no turns left");
	});

	it("keeps braces inside string values when finding the end of the arguments", () => {
		const call = parseToolCall(
			'[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"\\\\{\\\\}"}} trailing }',
		);
		expect(call?.args).toEqual({ command1: { type: "rg", pattern: "\\{\\}" } });
	});
});

describe("Devin responses", () => {
	it("reports an end-of-stream unauthenticated error as a credential failure", async () => {
		const response = stream("", { error: { code: "unauthenticated", message: "invalid api key" } });
		const body = Buffer.from(await response.arrayBuffer());
		expect(() => decodeChatResponse(body)).toThrow(DevinAuthError);
	});

	it("keeps only http(s) web results without embedded credentials", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							results: [
								{ url: "https://example.com/a", title: "A", summary: "excerpt" },
								{ url: "https://user:pw@example.com/b" },
								{ url: "javascript:alert(1)" },
								{ url: "http://example.com/c" },
							],
						}),
					),
			),
		);
		await expect(webSearch("k", "q", 5)).resolves.toEqual([
			{ url: "https://example.com/a", title: "A", summary: "excerpt" },
			{ url: "http://example.com/c" },
		]);
	});
});

describe("workspace confinement", () => {
	const workspace = new Workspace(root, async () => "");

	it("refuses traversal, absolute paths, and other drives", async () => {
		for (const file of ["/codebase/../escape.ts", "../escape.ts", "/etc/passwd", String.raw`C:\Windows\win.ini`]) {
			expect(await workspace.run({ type: "readfile", file })).toMatch(/outside project root/);
		}
	});

	it("refuses a symlink that points outside the root", async () => {
		const outside = mkdtempSync(join(tmpdir(), "search-outside-"));
		writeFileSync(join(outside, "secret.txt"), "secret");
		try {
			symlinkSync(outside, join(root, "link"), "dir");
		} catch {
			rmSync(outside, { recursive: true, force: true });
			return; // unprivileged Windows sessions cannot create symlinks
		}
		expect(await workspace.run({ type: "readfile", file: "/codebase/link/secret.txt" })).toMatch(/outside/);
		rmSync(outside, { recursive: true, force: true });
	});

	it("maps grep hits back onto the virtual root", async () => {
		const grep = new Workspace(root, async () => "retry.ts:1: export function retry() {");
		expect(await grep.run({ type: "rg", pattern: "retry", path: "/codebase/src" })).toBe(
			"/codebase/src/retry.ts:1: export function retry() {",
		);
	});
});

describe("search tool rows", () => {
	const context = (isError: boolean) =>
		({
			args: { query: "q", path: "src" },
			isError,
			isPartial: false,
			expanded: false,
		}) as unknown as ToolRenderContext<unknown, { path?: string }, CodeSearchDetails>;
	const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

	it("shows a failure while collapsed but nothing below the header for a collapsed success", () => {
		initTheme("dark");
		const failed = renderCodeSearchResult(
			{
				content: [{ type: "text", text: "Devin rejected the credential. Ask the user to run /search." }],
				details: undefined as never,
			},
			{ expanded: false, isPartial: false },
			theme,
			context(true),
		);
		expect(strip(failed.render(80)).join("\n")).toContain("Devin rejected the credential");
		const done = renderCodeSearchResult(
			{
				content: [{ type: "text", text: "1 candidate location" }],
				details: { locations: [{ path: "src/a.ts", ranges: [[1, 2]] }] },
			},
			{ expanded: false, isPartial: false },
			theme,
			context(false),
		);
		expect(done.render(80)).toEqual([]);
	});

	it("lists expanded locations relative to the searched path with ranges in file order", async () => {
		devin([
			answer('<ANSWER><file path="/codebase/src/retry.ts"><range>3-3</range><range>1-2</range></file></ANSWER>'),
		]);
		const locations = await codeSearch({ apiKey: "k", query: "q", root, cwd: root });
		const rows = renderCodeSearchResult(
			{ content: [], details: { locations } },
			{ expanded: true, isPartial: false },
			theme,
			context(false),
		);
		expect(strip(rows.render(80))).toEqual(["retry.ts   1-2 · 3"]);
	});
});
