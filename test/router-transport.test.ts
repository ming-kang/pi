import type { FetchFunction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexTransport } from "../src/extensions/router/transport.ts";

const endpoint = "https://relay.example/v1/responses";

describe("Codex HTTP transport", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("defaults to five attempts, exponential backoff, and one hook per error", async () => {
		const responses: Response[] = [];
		const times: number[] = [];
		const start = Date.now();
		const fetch = vi.fn<FetchFunction>(async () => {
			times.push(Date.now() - start);
			const response = new Response("failure", { status: 503 });
			responses.push(response);
			return response;
		});
		const hook = vi.fn(async (response: Response) => {
			expect(response.bodyUsed).toBe(false);
		});
		const pending = createCodexTransport(fetch, { onErrorResponse: hook })(endpoint);
		await vi.runAllTimersAsync();
		expect(await pending).toBe(responses[4]);
		expect(times).toEqual([0, 200, 600, 1400, 3000]);
		expect(hook.mock.calls.map(([response]) => response)).toEqual(responses);
		expect(responses.map((response) => response.bodyUsed)).toEqual([true, true, true, true, false]);
	});

	it.each([301, 400, 401, 403, 408, 409, 429, 499])("does not retry HTTP %i", async (status) => {
		const response = new Response("failure", { status });
		const fetch = vi.fn<FetchFunction>().mockResolvedValue(response);
		const hook = vi.fn();
		expect(await createCodexTransport(fetch, { onErrorResponse: hook })(endpoint)).toBe(response);
		expect(fetch).toHaveBeenCalledOnce();
		expect(hook).toHaveBeenCalledExactlyOnceWith(response);
		expect(response.bodyUsed).toBe(false);
	});

	it.each([500, 502, 504, 599])("retries HTTP %i without touching successful SSE", async (status) => {
		const success = new Response("opaque SSE bytes", { headers: { "content-type": "text/event-stream" } });
		const fetch = vi
			.fn<FetchFunction>()
			.mockResolvedValueOnce(new Response(null, { status }))
			.mockResolvedValue(success);
		const hook = vi.fn();
		const pending = createCodexTransport(fetch, { onErrorResponse: hook })(endpoint);
		await vi.runAllTimersAsync();
		expect(await pending).toBe(success);
		expect(success.bodyUsed).toBe(false);
		expect(hook).toHaveBeenCalledOnce();
	});

	it.each([new TypeError("fetch failed"), Object.assign(new Error("connection lost"), { code: "ECONNRESET" })])(
		"retries network failures without HTTP hooks",
		async (error) => {
			const fetch = vi.fn<FetchFunction>().mockRejectedValue(error);
			const hook = vi.fn();
			const pending = createCodexTransport(fetch, { onErrorResponse: hook })(endpoint);
			const rejected = expect(pending).rejects.toBe(error);
			await vi.runAllTimersAsync();
			await rejected;
			expect(fetch).toHaveBeenCalledTimes(5);
			expect(hook).not.toHaveBeenCalled();
		},
	);

	it.each([new DOMException("aborted", "AbortError"), new Error("custom failure")])(
		"does not retry other errors",
		async (error) => {
			const fetch = vi.fn<FetchFunction>().mockRejectedValue(error);
			await expect(createCodexTransport(fetch)(endpoint)).rejects.toBe(error);
			expect(fetch).toHaveBeenCalledOnce();
		},
	);

	it.each([-2, 0, 1.9, 101, Number.POSITIVE_INFINITY])("clamps retry budget %s", async (maxRetries) => {
		const fetch = vi.fn<FetchFunction>(async () => new Response(null, { status: 500 }));
		const pending = createCodexTransport(fetch, { maxRetries, maxRetryDelayMs: 0 })(endpoint);
		await vi.runAllTimersAsync();
		await pending;
		expect(fetch).toHaveBeenCalledTimes(Math.min(100, Math.max(0, Math.floor(maxRetries))) + 1);
	});

	it.each([0, 0.999])("applies jitter and caps delay (%s)", async (random) => {
		vi.mocked(Math.random).mockReturnValue(random);
		const times: number[] = [];
		const start = Date.now();
		const fetch = vi.fn<FetchFunction>(async () => {
			times.push(Date.now() - start);
			return new Response(null, { status: 500 });
		});
		const pending = createCodexTransport(fetch, { maxRetries: 2, maxRetryDelayMs: 250 })(endpoint);
		await vi.runAllTimersAsync();
		await pending;
		const first = Math.floor(200 * (0.9 + random * 0.2));
		expect(times).toEqual([0, first, first + 250]);
	});

	it.each(["outer", "init", "request"])("aborts backoff from %s signal", async (source) => {
		const controller = new AbortController();
		const other = new AbortController();
		const fetch = vi.fn<FetchFunction>(async () => new Response(null, { status: 503 }));
		const pending = createCodexTransport(fetch, { signal: source === "outer" ? controller.signal : other.signal })(
			new Request(endpoint, { signal: source === "request" ? controller.signal : other.signal }),
			{ signal: source === "init" ? controller.signal : other.signal },
		);
		const reason = new Error("cancelled");
		const rejected = expect(pending).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort(reason);
		await rejected;
		await vi.runAllTimersAsync();
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not dispatch a pre-aborted request or retry an in-flight abort reported as TypeError", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		const fetch = vi.fn<FetchFunction>(async () => {
			controller.abort(reason);
			throw new TypeError("fetch failed");
		});
		const transport = createCodexTransport(fetch, { signal: controller.signal });
		await expect(transport(endpoint)).rejects.toBe(reason);
		await expect(transport(endpoint)).rejects.toBe(reason);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("does not retry callback TypeErrors and cancels the discarded body", async () => {
		const response = new Response("failure", { status: 503 });
		const fetch = vi.fn<FetchFunction>().mockResolvedValue(response);
		const error = new TypeError("hook failed");
		const hook = vi.fn(async () => {
			throw error;
		});
		await expect(createCodexTransport(fetch, { onErrorResponse: hook })(endpoint)).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledOnce();
		expect(hook).toHaveBeenCalledOnce();
		expect(response.bodyUsed).toBe(true);
	});

	it.each(["request", "stream", "consumed"])("never replays a %s body", async (kind) => {
		const request = new Request(endpoint, { method: "POST", body: "private prompt" });
		if (kind === "consumed") await request.text();
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					controller.close();
				},
			}),
			duplex: "half",
		};
		const fetch = vi.fn<FetchFunction>(async (input, options) => {
			if (kind === "consumed") throw new TypeError("body already used");
			await new Request(input, options).text();
			return new Response(null, { status: 500 });
		});
		const pending = createCodexTransport(fetch)(
			kind === "stream" ? endpoint : request,
			kind === "stream" ? init : undefined,
		);
		if (kind === "consumed") await expect(pending).rejects.toThrow("body already used");
		else expect((await pending).status).toBe(500);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("preserves input, resolved auth, string body and custom init through retries", async () => {
		const request = new Request(endpoint, { method: "POST", body: "replaced" });
		const init = {
			method: "POST",
			body: "private prompt",
			headers: { Authorization: "Bearer resolved-key" },
			dispatcher: {},
		};
		const fetch = vi
			.fn<FetchFunction>()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValue(new Response(null));
		const pending = createCodexTransport(fetch)(request, init);
		await vi.runAllTimersAsync();
		await pending;
		for (const [input, options] of fetch.mock.calls) {
			expect(input).toBe(request);
			expect(options).toMatchObject(init);
			expect(options?.headers).toBe(init.headers);
		}
		expect(request.bodyUsed).toBe(false);
	});
});
