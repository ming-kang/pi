import { afterEach, describe, expect, it, vi } from "vitest";
import { callDeepWiki } from "../src/extensions/deepwiki/client.ts";
import { DEEPWIKI_RESPONSE_BODY_BYTES } from "../src/extensions/deepwiki/http.ts";

function rpcResult(text: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: {
			content: [{ type: "text", text }],
			...extra,
		},
	});
}

function uniqueRepo(label: string): string {
	return `phase4/${label}`;
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepWiki MCP client", () => {
	it("parses JSON tool results and extracts structure page titles", async () => {
		let requestBody = "";
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = String(init?.body ?? "");
			return new Response(rpcResult("- 1 Introduction\n- 2 Extension API"), {
				headers: { "content-type": "application/json" },
			});
		});
		const result = await callDeepWiki({ action: "structure", repoName: uniqueRepo("json-structure") }, undefined);
		expect(result).toMatchObject({
			toolName: "read_wiki_structure",
			text: "- 1 Introduction\n- 2 Extension API",
			pageTitles: ["Introduction", "Extension API"],
		});
		const request = JSON.parse(requestBody) as { method: string; params: { name: string; arguments: unknown } };
		expect(request.method).toBe("tools/call");
		expect(request.params).toEqual({
			name: "read_wiki_structure",
			arguments: { repoName: uniqueRepo("json-structure") },
		});
	});

	it("parses SSE JSON-RPC envelopes and contents page titles", async () => {
		const envelope = rpcResult("# Page: Overview\nBody\n# Page: API\nDetails");
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(`event: message\ndata: ${envelope}\n\ndata: [DONE]\n\n`, {
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				}),
		);
		const result = await callDeepWiki({ action: "contents", repoName: uniqueRepo("sse-contents") }, undefined);
		expect(result.pageTitles).toEqual(["Overview", "API"]);
		expect(result.text).toContain("# Page: API");
	});

	it("accepts MCP structuredContent when text content is absent", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { structuredContent: { result: "Structured answer" } },
					}),
				),
		);
		const result = await callDeepWiki(
			{ action: "question", repoName: uniqueRepo("structured-answer"), question: "How?" },
			undefined,
		);
		expect(result.text).toBe("Structured answer");
	});

	it("surfaces JSON-RPC, MCP, repository, JSON, and SSE protocol errors", async () => {
		const cases: Array<{ label: string; response: Response; message: RegExp }> = [
			{
				label: "rpc-error",
				response: new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "RPC unavailable" } }),
				),
				message: /RPC unavailable/,
			},
			{
				label: "mcp-error",
				response: new Response(rpcResult("Tool execution failed", { isError: true })),
				message: /Tool execution failed/,
			},
			{
				label: "repository-error",
				response: new Response(rpcResult("Error fetching wiki for phase4/repository-error: Repository not found.")),
				message: /Repository not found/,
			},
			{
				label: "invalid-json",
				response: new Response("not json"),
				message: /invalid JSON/,
			},
			{
				label: "empty-sse",
				response: new Response("event: ping\n\n", { headers: { "content-type": "text/event-stream" } }),
				message: /empty event stream/,
			},
		];
		for (const testCase of cases) {
			vi.stubGlobal("fetch", async () => testCase.response);
			await expect(
				callDeepWiki({ action: "structure", repoName: uniqueRepo(testCase.label) }, undefined),
			).rejects.toThrow(testCase.message);
		}
	});

	it("reuses the full contents cache across page references", async () => {
		const fetchMock = vi.fn(async () => new Response(rpcResult("# Page: One\nFirst\n# Page: Two\nSecond")));
		vi.stubGlobal("fetch", fetchMock);
		const repoName = uniqueRepo("page-cache");
		const first = await callDeepWiki({ action: "contents", repoName, page: 1 }, undefined);
		const second = await callDeepWiki({ action: "contents", repoName, page: 2 }, undefined);
		expect(first.cacheHit).toBeUndefined();
		expect(second.cacheHit).toBe(true);
		expect(second.text).toBe(first.text);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("checks caller cancellation before returning a cache hit", async () => {
		const fetchMock = vi.fn(async () => new Response(rpcResult("Cached answer")));
		vi.stubGlobal("fetch", fetchMock);
		const params = { action: "question" as const, repoName: uniqueRepo("abort-cache"), question: "How?" };
		await callDeepWiki(params, undefined);
		const controller = new AbortController();
		controller.abort();
		await expect(callDeepWiki(params, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("does not cache an oversized transport response", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(DEEPWIKI_RESPONSE_BODY_BYTES + 1));
							},
						}),
					),
			)
			.mockImplementationOnce(async () => new Response(rpcResult("Recovered response")));
		vi.stubGlobal("fetch", fetchMock);
		const params = { action: "structure" as const, repoName: uniqueRepo("oversize-cache") };
		await expect(callDeepWiki(params, undefined)).rejects.toThrow(
			`DeepWiki response exceeded ${DEEPWIKI_RESPONSE_BODY_BYTES} bytes`,
		);
		await expect(callDeepWiki(params, undefined)).resolves.toMatchObject({ text: "Recovered response" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
