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
	const workspace = new Workspace(root);

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

	it("reports rg hits on the virtual root, for a directory and for a single file", async () => {
		expect(await workspace.run({ type: "rg", pattern: "retry", path: "/codebase/src" })).toBe(
			"/codebase/src/retry.ts:1:export function retry() {",
		);
		expect(await workspace.run({ type: "rg", pattern: "return", path: "/codebase/src/retry.ts" })).toBe(
			"/codebase/src/retry.ts:2:  return 1;",
		);
	});
});

describe("workspace rg", () => {
	const repo = mkdtempSync(join(tmpdir(), "search-rg-"));
	afterAll(() => rmSync(repo, { recursive: true, force: true }));
	const write = (path: string, text: string) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};

	it("applies every include and exclude glob", async () => {
		for (const path of ["src/a.ts", "src/b.tsx", "src/c.js", "test/a.test.ts"]) write(path, "const needle = 1;\n");
		const out = await new Workspace(repo).run({
			type: "rg",
			pattern: "needle",
			path: "/codebase",
			include: ["**/*.ts", "**/*.tsx"],
			exclude: ["**/test/**"],
		});
		expect(out).toBe("/codebase/src/a.ts:1:const needle = 1;\n/codebase/src/b.tsx:1:const needle = 1;");
	});

	it("leads an over-broad search with matches per file", async () => {
		for (let i = 10; i < 40; i++) write(`many/f${i}.ts`, "hit\nhit\n");
		write("many/z.ts", "hit\nhit\nhit\n");
		const lines = (await new Workspace(repo).run({ type: "rg", pattern: "hit", path: "/codebase/many" })).split("\n");
		expect(lines[0]).toMatch(/^63 matches in 31 files;/);
		expect(lines[1]).toBe("/codebase/many/z.ts: 3");
		expect(lines.length).toBeLessThanOrEqual(41);
	});
});

describe("workspace visibility and paging", () => {
	const repo = mkdtempSync(join(tmpdir(), "search-visible-"));
	afterAll(() => rmSync(repo, { recursive: true, force: true }));
	const write = (path: string, text: string) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	write(".gitignore", ".env\ndist/\n");
	write(".env", "TOKEN=SECRET\n");
	write("dist/bundle.js", "SECRET\n");
	write("src/a.ts", Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	for (let i = 0; i < 30; i++) write(`pkgs/p${i}/index.ts`, "x\n");

	it("keeps ignored files out of readfile, rg, and tree, even when named directly", async () => {
		const workspace = new Workspace(repo);
		expect(await workspace.run({ type: "readfile", file: "/codebase/.env" })).toMatch(/not searchable/);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase/.env" })).toMatch(/not searchable/);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase/dist" })).toMatch(/not searchable/);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase" })).toBe("(no matches)");
		const { tree } = await workspace.repoMap();
		expect(tree).toContain("└── src/");
		expect(tree).not.toMatch(/\.env|dist/);
	});

	it("states a file's length and where to continue a clipped read", async () => {
		const lines = (await new Workspace(repo).run({ type: "readfile", file: "src/a.ts", end_line: 100 })).split("\n");
		expect(lines[0]).toBe("/codebase/src/a.ts (100 lines)");
		expect(lines[1]).toBe("1:line 1");
		expect(lines.at(-1)).toBe("... (lines 41-100 not shown; continue with start_line=41)");
	});

	it("shallows a tree that would not fit rather than cutting it off", async () => {
		const out = await new Workspace(repo).run({ type: "tree", path: "/codebase/pkgs", levels: 2 });
		expect(out.split("\n")).toHaveLength(32);
		expect(out).toMatch(/├── p0\/\n/);
		expect(out).toMatch(/\(levels reduced to 1 to fit\)$/);
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
