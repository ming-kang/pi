import { afterEach, describe, expect, test, vi } from "vitest";
import { executeWebSearch } from "../src/extensions/web-search/execute.ts";
import { formatSearchOutput } from "../src/extensions/web-search/format.ts";
import { MAX_ERROR_MESSAGE_LENGTH } from "../src/extensions/web-search/results.ts";

afterEach(() => vi.unstubAllGlobals());

describe("executeWebSearch", () => {
	test("starts both providers before either returns and labels successful empty responses", async () => {
		const pending: Array<(response: Response) => void> = [];
		vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));
		const execution = executeWebSearch(
			{ query: "release" },
			{
				minimax: { key: "mm", host: "https://minimax.test" },
				deepseek: { key: "ds" },
			},
		);
		expect(pending).toHaveLength(2);
		pending[0](new Response(JSON.stringify({ organic: [] })));
		pending[1](new Response(JSON.stringify({ content: [{ type: "web_search_tool_result", content: [] }] })));
		await expect(execution).resolves.toMatchObject({ status: "success", engine: "dual", hits: [] });
	});
	test("keeps a successful provider result when DeepSeek violates its structured contract", async () => {
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("coding_plan/search")) {
				return new Response(
					JSON.stringify({ organic: [{ title: "MiniMax result", link: "https://example.com/result" }] }),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({ content: [{ type: "text", text: "text only" }] }), { status: 200 });
		});

		const execution = await executeWebSearch(
			{ query: "current release" },
			{
				minimax: { key: "mm", host: "https://minimax.example" },
				deepseek: { key: "ds" },
			},
		);
		expect(execution.status).toBe("success");
		expect(execution.engine).toBe("minimax");
		expect(execution.hits).toHaveLength(1);
		expect(formatSearchOutput(execution)).toContain("MiniMax result");
		expect(formatSearchOutput(execution)).not.toContain("text only");
	});

	test("returns a bounded tool error when every configured provider fails", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("provider unavailable");
		});
		const execution = await executeWebSearch(
			{ query: "current release" },
			{
				minimax: { key: "mm", host: "https://minimax.example" },
				deepseek: { key: "ds" },
			},
		);
		expect(execution.status).toBe("error");
		expect(execution.errorMessage).toContain("provider unavailable");
		expect(execution.errorMessage?.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
	});

	test("propagates caller cancellation instead of returning a tool error", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			executeWebSearch(
				{ query: "current release" },
				{ minimax: { key: "key", host: "https://example.invalid" } },
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	test("propagates cancellation after provider requests have started", async () => {
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		vi.stubGlobal(
			"fetch",
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					markStarted?.();
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);

		const execution = executeWebSearch(
			{ query: "current release" },
			{ minimax: { key: "key", host: "https://example.test" } },
			controller.signal,
		);
		await started;
		controller.abort();
		await expect(execution).rejects.toMatchObject({ name: "AbortError" });
	});
});
