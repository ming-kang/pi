import { describe, expect, it } from "vitest";
import { parseResponse, parseToolCall } from "../src/extensions/search/client.ts";
import { classifyError, SearchError } from "../src/extensions/search/errors.ts";
import { connectFrameEncode, ProtobufEncoder } from "../src/extensions/search/protocol.ts";

describe("parseToolCall", () => {
	it("splits thinking text, tool name, and arguments", () => {
		const out = parseToolCall(
			'I will search now.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase"}}',
		);
		expect(out).not.toBeNull();
		expect(out![0]).toBe("I will search now.");
		expect(out![1]).toBe("restricted_exec");
		expect(out![2]).toEqual({ command1: { type: "tree", path: "/codebase" } });
	});

	it("keeps inner braces and ignores trailing noise", () => {
		const out = parseToolCall('[TOOL_CALLS]answer[ARGS]{"answer":"<ANSWER>{not json}</ANSWER>"} trailing noise');
		expect(out?.[1]).toBe("answer");
		expect(out?.[2].answer).toBe("<ANSWER>{not json}</ANSWER>");
	});

	it("repairs unquoted keys", () => {
		const out = parseToolCall(
			'[TOOL_CALLS]restricted_exec[ARGS]{command1: {type: "rg", pattern: "x", path: "/codebase"}}',
		);
		expect(out?.[2].command1).toEqual({ type: "rg", pattern: "x", path: "/codebase" });
	});

	it("strips a trailing </s>", () => {
		expect(parseToolCall('[TOOL_CALLS]answer[ARGS]{"answer":"ok"}</s>')).not.toBeNull();
	});

	it("returns null when there is no usable envelope", () => {
		expect(parseToolCall("no tool call here")).toBeNull();
		expect(parseToolCall("[TOOL_CALLS]x[ARGS]not-json")).toBeNull();
		expect(parseToolCall('[TOOL_CALLS]x[ARGS]{"a": <unfixable>}')).toBeNull();
	});
});

describe("parseResponse", () => {
	it("surfaces an error frame instead of a tool call", () => {
		const frame = connectFrameEncode(
			Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: "quota" } })),
		);
		const [text, tool] = parseResponse(frame);
		expect(text).toBe("[Error] resource_exhausted: quota");
		expect(tool).toBeNull();
	});

	it("recovers a tool call from raw frame text", () => {
		const payload = Buffer.from(
			'thinking…[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase"}}',
		);
		const [thinking, tool] = parseResponse(connectFrameEncode(payload));
		expect(tool?.[0]).toBe("restricted_exec");
		expect(thinking).toBe("thinking…");
	});

	it("recovers prose through extractStrings when no tool is called", () => {
		const enc = new ProtobufEncoder().writeString(3, "a plain assistant answer without any tool call");
		const [text, tool] = parseResponse(connectFrameEncode(enc.toBuffer()));
		expect(tool).toBeNull();
		expect(text).toContain("plain assistant answer");
	});
});

function httpError(status: number): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

function namedError(name: string, message = name): Error {
	return Object.assign(new Error(message), { name });
}

describe("classifyError", () => {
	it("maps HTTP statuses onto the failure taxonomy", () => {
		expect(classifyError(httpError(413)).code).toBe("PAYLOAD_TOO_LARGE");
		expect(classifyError(httpError(429)).code).toBe("RATE_LIMITED");
		expect(classifyError(httpError(401)).code).toBe("AUTH_ERROR");
		expect(classifyError(httpError(403)).code).toBe("AUTH_ERROR");
		expect(classifyError(httpError(500)).code).toBe("SERVER_ERROR");
		expect(classifyError(httpError(404)).code).toBe("SERVER_ERROR");
	});

	it("reads aborts, timeout names, and timeout messages as TIMEOUT", () => {
		expect(classifyError(namedError("AbortError", "The operation was aborted")).code).toBe("TIMEOUT");
		expect(classifyError(namedError("TimeoutError", "x")).code).toBe("TIMEOUT");
		expect(classifyError(new Error("request timeout exceeded")).code).toBe("TIMEOUT");
	});

	it("falls back to NETWORK_ERROR and passes a SearchError through unchanged", () => {
		expect(classifyError(new Error("ECONNRESET")).code).toBe("NETWORK_ERROR");
		const already = new SearchError("x", "RATE_LIMITED");
		expect(classifyError(already)).toBe(already);
	});
});
