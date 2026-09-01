import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPWIKI_RESPONSE_BODY_BYTES, fetchWithRetry } from "../src/extensions/deepwiki/http.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("DeepWiki bounded HTTP transport", () => {
	it("rejects and cancels an oversized body without retrying a deterministic limit failure", async () => {
		const cancelled = vi.fn();
		const fetchMock = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(DEEPWIKI_RESPONSE_BODY_BYTES + 1));
						},
						cancel: cancelled,
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchWithRetry("https://deepwiki.example/mcp", {}, { timeoutMs: 1000, retries: 2, label: "DeepWiki" }),
		).rejects.toThrow(`DeepWiki response exceeded ${DEEPWIKI_RESPONSE_BODY_BYTES} bytes`);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it("returns bounded non-retryable HTTP responses to the domain parser", async () => {
		vi.stubGlobal("fetch", async () => new Response("bad request", { status: 400 }));
		const result = await fetchWithRetry(
			"https://deepwiki.example/mcp",
			{},
			{
				timeoutMs: 1000,
				retries: 2,
				label: "DeepWiki",
			},
		);
		expect(result.response.status).toBe(400);
		expect(result.text).toBe("bad request");
	});

	it("retries a transient HTTP status and returns the successful attempt", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const request = fetchWithRetry(
			"https://deepwiki.example/mcp",
			{},
			{
				timeoutMs: 5000,
				retries: 1,
				label: "DeepWiki",
			},
		);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(request).resolves.toMatchObject({ text: "ok" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("cancels a pending body read when the caller aborts", async () => {
		let markPull: (() => void) | undefined;
		const pulled = new Promise<void>((resolve) => {
			markPull = resolve;
		});
		const cancelled = vi.fn();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull() {
							markPull?.();
							return new Promise<void>(() => {});
						},
						cancel: cancelled,
					}),
				),
		);
		const controller = new AbortController();
		const request = fetchWithRetry(
			"https://deepwiki.example/mcp",
			{},
			{
				timeoutMs: 5000,
				retries: 0,
				signal: controller.signal,
				label: "DeepWiki",
			},
		);
		await pulled;
		controller.abort();
		await expect(request).rejects.toThrow("DeepWiki request aborted");
		expect(cancelled).toHaveBeenCalledOnce();
	});
});
