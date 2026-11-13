/**
 * Transport boundaries for the Devin calls: nothing is read unbounded, and a malformed or hostile
 * Connect stream is rejected rather than silently producing a short answer.
 */
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevinAuthError, decodeChatResponse, webSearch } from "../src/extensions/search/devin.ts";

afterEach(() => vi.unstubAllGlobals());

/** A Connect data frame: flags byte, big-endian length, payload. */
function frame(flags: number, payload: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head[0] = flags;
	head.writeUInt32BE(payload.length, 1);
	return Buffer.concat([head, payload]);
}

/** A protobuf field-2 length-delimited value, the shape the planner's text arrives in. */
function textField(text: string): Buffer {
	const data = Buffer.from(text, "utf-8");
	return Buffer.concat([Buffer.from([0x12, data.length]), data]);
}

const reply = (text: string) => Buffer.concat([frame(1, gzipSync(textField(text))), frame(2, Buffer.from("{}"))]);

function stub(status = 200, body: string | Uint8Array = "{}"): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status })),
	);
}

describe("decodeChatResponse", () => {
	it("returns the text of a well-formed stream", () => {
		expect(decodeChatResponse(reply("hello planner"))).toBe("hello planner");
	});

	it("rejects a frame whose length runs past the body", () => {
		const body = Buffer.concat([Buffer.from([0, 0, 0, 0, 10]), Buffer.from("abc")]);
		expect(() => decodeChatResponse(body)).toThrow(/truncated planner frame/);
	});

	it("rejects a header cut short by a partial read", () => {
		expect(() => decodeChatResponse(Buffer.from([1, 0, 0]))).toThrow(/truncated planner frame/);
	});

	it("rejects trailing bytes that are not a whole frame", () => {
		expect(() => decodeChatResponse(Buffer.concat([reply("x"), Buffer.from([1, 2])]))).toThrow(
			/truncated planner frame/,
		);
	});

	it("rejects flags reserved by the protocol", () => {
		expect(() => decodeChatResponse(frame(0x04, Buffer.from("x")))).toThrow(/reserved flags/);
		expect(() => decodeChatResponse(frame(0x80, Buffer.from("x")))).toThrow(/reserved flags/);
	});

	it("caps the total decompressed text a gzip frame can expand to", () => {
		const bomb = frame(1, gzipSync(Buffer.alloc(32 * 1024 * 1024)));
		expect(() => decodeChatResponse(bomb)).toThrow(/too large/);
	});

	it("rejects a corrupt gzip frame", () => {
		expect(() => decodeChatResponse(frame(1, Buffer.from("not gzip at all")))).toThrow(/malformed planner frame/);
	});

	it("rejects an unparseable end frame", () => {
		expect(() => decodeChatResponse(Buffer.concat([frame(2, Buffer.from("{oops"))]))).toThrow(
			/malformed planner end frame/,
		);
	});

	it("still reports the error an end frame names", () => {
		const end = frame(2, Buffer.from(JSON.stringify({ error: { code: "unauthenticated" } })));
		expect(() => decodeChatResponse(end)).toThrow(DevinAuthError);
	});

	describe("protobuf field scanning", () => {
		const payload = (bytes: number[]) => frame(0, Buffer.from(bytes));

		it("rejects field number zero", () => {
			expect(() => decodeChatResponse(payload([0x00]))).toThrow(/malformed protobuf/);
		});

		it("rejects an unterminated varint", () => {
			expect(() => decodeChatResponse(payload([0x12, 0x80]))).toThrow(/malformed protobuf/);
		});

		it("rejects a varint wider than ten bytes", () => {
			expect(() => decodeChatResponse(payload([0x12, ...Array.from({ length: 11 }, () => 0x80)]))).toThrow(
				/malformed protobuf/,
			);
		});

		it("rejects a length that runs past the payload", () => {
			expect(() => decodeChatResponse(payload([0x12, 0x64]))).toThrow(/malformed protobuf/);
		});

		it("rejects a fixed-width field that runs past the payload", () => {
			expect(() => decodeChatResponse(payload([0x09, 1, 2]))).toThrow(/malformed protobuf/);
		});

		it("rejects an unsupported wire type", () => {
			expect(() => decodeChatResponse(payload([0x0b]))).toThrow(/malformed protobuf/);
		});
	});
});

describe("Devin transport bounds", () => {
	it("maps a small error body to the credential and rate-limit failures it names", async () => {
		stub(401, JSON.stringify({ code: "unauthenticated", message: "bad key" }));
		await expect(webSearch("k", "q", 1)).rejects.toThrow(DevinAuthError);
		stub(429, JSON.stringify({ code: "resource_exhausted" }));
		await expect(webSearch("k", "q", 1)).rejects.toThrow(/rate-limited/);
	});

	it("falls back to the status when an error body is too large to trust", async () => {
		stub(500, JSON.stringify({ code: "unauthenticated", message: "x".repeat(70 * 1024) }));
		await expect(webSearch("k", "q", 1)).rejects.toThrow("Devin request failed (500)");
	});

	it("refuses a web search reply past the byte budget", async () => {
		const rows = Array.from({ length: 60_000 }, (_, i) => ({ url: `https://example.com/${i}` }));
		stub(200, JSON.stringify({ results: rows }));
		await expect(webSearch("k", "q", 5)).rejects.toThrow(/web search reply exceeded/);
	});

	it("refuses a planner reply past the byte budget", async () => {
		const oversized = Buffer.alloc(9 * 1024 * 1024);
		oversized.writeUInt32BE(oversized.length - 5, 1);
		stub(200, new Uint8Array(oversized));
		const { chat } = await import("../src/extensions/search/devin.ts");
		await expect(chat("k", [{ role: "user", content: "q" }], "[]")).rejects.toThrow(/planner reply exceeded/);
	});
});
