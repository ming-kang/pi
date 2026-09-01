import { describe, expect, it, vi } from "vitest";
import { readResponseTextBounded } from "../src/utils/http-response.ts";

function streamedResponse(chunks: Uint8Array[], onCancel?: () => void, close = true): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				if (close) controller.close();
			},
			cancel() {
				onCancel?.();
			},
		}),
	);
}

describe("readResponseTextBounded", () => {
	it("reads streamed UTF-8 text up to an exact byte boundary", async () => {
		const encoder = new TextEncoder();
		const response = streamedResponse([encoder.encode("A"), encoder.encode("猫"), encoder.encode("B")]);
		await expect(readResponseTextBounded(response, { maxBytes: 5, overflowMessage: "too large" })).resolves.toBe(
			"A猫B",
		);
	});

	it("returns a byte-bounded prefix and cancels the remaining stream", async () => {
		const cancelled = vi.fn();
		const response = streamedResponse([new TextEncoder().encode("A猫B")], cancelled, false);
		await expect(readResponseTextBounded(response, { maxBytes: 4 })).resolves.toBe("A猫");
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it("throws the configured overflow error and cancels the stream", async () => {
		const cancelled = vi.fn();
		const response = streamedResponse([new TextEncoder().encode("abcdef")], cancelled, false);
		await expect(
			readResponseTextBounded(response, { maxBytes: 5, overflowMessage: "response too large" }),
		).rejects.toThrow("response too large");
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it("cancels a pending read and preserves the caller abort reason", async () => {
		const cancelled = vi.fn();
		let markPull: (() => void) | undefined;
		const pulled = new Promise<void>((resolve) => {
			markPull = resolve;
		});
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull() {
					markPull?.();
					return new Promise<void>(() => {});
				},
				cancel: cancelled,
			}),
		);
		const controller = new AbortController();
		const read = readResponseTextBounded(response, { maxBytes: 100, signal: controller.signal });
		await pulled;
		controller.abort();
		await expect(read).rejects.toMatchObject({ name: "AbortError" });
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it("bounds non-streaming response implementations by encoded bytes", async () => {
		const response = {
			body: null,
			text: async () => "A猫B",
		} as unknown as Response;
		await expect(readResponseTextBounded(response, { maxBytes: 4 })).resolves.toBe("A猫");
		await expect(
			readResponseTextBounded(response, { maxBytes: 4, overflowMessage: "fallback too large" }),
		).rejects.toThrow("fallback too large");
	});

	it("rejects invalid byte limits before consuming the body", async () => {
		const text = vi.fn(async () => "unused");
		const response = { body: null, text } as unknown as Response;
		await expect(readResponseTextBounded(response, { maxBytes: Number.NaN })).rejects.toThrow(RangeError);
		await expect(readResponseTextBounded(response, { maxBytes: -1 })).rejects.toThrow(RangeError);
		expect(text).not.toHaveBeenCalled();
	});
});
