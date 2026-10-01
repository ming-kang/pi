import { afterEach, describe, expect, test, vi } from "vitest";
import { searchDeepSeek } from "../src/extensions/web-search/providers/deepseek.ts";
import { postJson } from "../src/extensions/web-search/providers/http.ts";
import { searchMiniMax } from "../src/extensions/web-search/providers/minimax.ts";

afterEach(() => vi.unstubAllGlobals());

describe("provider HTTP boundaries", () => {
	test("sends query-only MiniMax requests and parses results", async () => {
		let requestBody = "";
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = String(init?.body ?? "");
			return new Response(
				JSON.stringify({
					organic: [
						{ title: "Result", link: "https://example.com/result" },
						{ title: "Malformed without a link" },
					],
				}),
				{ status: 200 },
			);
		});
		const result = await searchMiniMax({ query: "  current release  ", apiKey: "key" });
		expect(JSON.parse(requestBody)).toEqual({ q: "current release" });
		expect(result.hits).toHaveLength(1);
	});

	test("keeps the DeepSeek tool request simple and accepts structured search results", async () => {
		let requestBody = "";
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = String(init?.body ?? "");
			return new Response(
				JSON.stringify({
					content: [
						{
							type: "web_search_tool_result",
							tool_use_id: "tool",
							content: [
								{
									type: "web_search_result",
									title: "Current release",
									url: "https://example.com/release",
								},
							],
						},
						{ type: "text", text: "Synthesis" },
					],
				}),
				{ status: 200 },
			);
		});
		const result = await searchDeepSeek({ query: "current release", apiKey: "key" });
		const body = JSON.parse(requestBody) as { tools: unknown[] };
		expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
		expect(result.hits).toEqual([
			{
				title: "Current release",
				url: "https://example.com/release",
				date: undefined,
			},
		]);
		expect(result.synthesisText).toBe("Synthesis");
	});

	test("treats a structured empty DeepSeek result as a legitimate zero-result response", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						content: [
							{ type: "text", text: "No matching pages were found." },
							{ type: "web_search_tool_result", tool_use_id: "tool", content: [] },
						],
					}),
					{ status: 200 },
				),
		);
		await expect(searchDeepSeek({ query: "missing release", apiKey: "key" })).resolves.toMatchObject({
			hits: [],
			synthesisText: "No matching pages were found.",
		});
	});

	test("rejects text-only, malformed, and structured-error DeepSeek responses", async () => {
		const payloads = [
			{ content: [{ type: "text", text: "Unsupported synthesis" }] },
			{
				content: [
					{ type: "web_search_tool_result", tool_use_id: "tool", content: { invalid: true } },
					{ type: "text", text: "Must not survive" },
				],
			},
			{
				content: [
					{
						type: "web_search_tool_result",
						tool_use_id: "tool",
						content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
					},
				],
			},
		];
		for (const payload of payloads) {
			vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload), { status: 200 }));
			await expect(searchDeepSeek({ query: "current release", apiKey: "key" })).rejects.toThrow(/DeepSeek/);
		}
	});

	test("rejects oversized successful response bodies", async () => {
		vi.stubGlobal("fetch", async () => new Response(`"${"x".repeat(2 * 1024 * 1024)}"`, { status: 200 }));
		await expect(postJson("https://example.test", {}, {}, undefined, 1000, "Search API")).rejects.toThrow(
			"Search API response exceeded 2097152 bytes",
		);
	});

	test("bounds non-OK response bodies before surfacing them", async () => {
		vi.stubGlobal("fetch", async () => new Response("x".repeat(1000), { status: 500, statusText: "Failed" }));
		await expect(postJson("https://example.test", {}, {}, undefined, 1000, "Search API")).rejects.toThrow(
			`Search API returned HTTP 500 Failed: ${"x".repeat(200)}`,
		);
	});

	test("preserves cancellation while reading a non-OK response body", async () => {
		const controller = new AbortController();
		let markBodyRead: (() => void) | undefined;
		const bodyRead = new Promise<void>((resolve) => {
			markBodyRead = resolve;
		});
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			const requestSignal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(streamController) {
						requestSignal?.addEventListener("abort", () => streamController.error(requestSignal.reason), {
							once: true,
						});
					},
					pull() {
						markBodyRead?.();
						return new Promise<void>(() => {});
					},
				}),
				{ status: 500, statusText: "Failed" },
			);
		});

		const request = postJson("https://example.test", {}, {}, controller.signal, 1000, "Search API");
		await bodyRead;
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
	});
});
