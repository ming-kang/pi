import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { classifyError, parseResponse, parseToolCall, SearchError } from "../src/extensions/search/client.ts";
import { connectFrameEncode, ProtobufEncoder } from "../src/extensions/search/protocol.ts";

{
	const out = parseToolCall(
		'I will search now.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase"}}',
	);
	assert.ok(out, "valid envelope parses");
	const [thinking, name, args] = out;
	assert.equal(thinking, "I will search now.", "thinking text preserved");
	assert.equal(name, "restricted_exec", "tool name extracted");
	assert.deepEqual(args, { command1: { type: "tree", path: "/codebase" } }, "args parsed");
}

{
	const out = parseToolCall('[TOOL_CALLS]answer[ARGS]{"answer":"<ANSWER>{not json}</ANSWER>"} trailing noise');
	assert.ok(out, "nested/trailing braces parse");
	assert.equal(out[1], "answer");
	assert.equal(out[2].answer, "<ANSWER>{not json}</ANSWER>", "inner braces kept verbatim");
}

{
	const out = parseToolCall(
		'[TOOL_CALLS]restricted_exec[ARGS]{command1: {type: "rg", pattern: "x", path: "/codebase"}}',
	);
	assert.ok(out, "unquoted keys repaired");
	const cmd = out[2].command1 as Record<string, unknown>;
	assert.equal(cmd.type, "rg", "repaired JSON has expected fields");
}

assert.ok(parseToolCall('[TOOL_CALLS]answer[ARGS]{"answer":"ok"}</s>'), "</s> suffix stripped");
assert.equal(parseToolCall("no tool call here"), null, "plain text -> null");
assert.equal(parseToolCall("[TOOL_CALLS]x[ARGS]not-json"), null, "malformed args section -> null");
assert.equal(parseToolCall('[TOOL_CALLS]x[ARGS]{"a": <unfixable>}'), null, "unrepairable JSON -> null");

{
	const errFrame = connectFrameEncode(
		Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: "quota" } })),
	);
	const [text, tool] = parseResponse(errFrame);
	assert.equal(text, "[Error] resource_exhausted: quota", "error frame surfaced");
	assert.equal(tool, null, "no tool call on error frame");
}

{
	const payload = Buffer.from(
		'thinking…[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase"}}',
	);
	const [thinking, tool] = parseResponse(connectFrameEncode(payload));
	assert.ok(tool, "tool call recovered from raw frame text");
	assert.equal(tool![0], "restricted_exec");
	assert.equal(thinking, "thinking…");
}

{
	const enc = new ProtobufEncoder();
	enc.writeString(3, "a plain assistant answer without any tool call");
	const [text, tool] = parseResponse(connectFrameEncode(enc.toBuffer()));
	assert.equal(tool, null, "no tool call -> null");
	assert.ok(text.includes("plain assistant answer"), "text recovered via extractStrings");
}

function withStatus(status: number): Error & { status?: number } {
	const e: Error & { status?: number } = new Error(`HTTP ${status}`);
	e.status = status;
	return e;
}
assert.equal(classifyError(withStatus(413)).code, "PAYLOAD_TOO_LARGE", "413");
assert.equal(classifyError(withStatus(429)).code, "RATE_LIMITED", "429");
assert.equal(classifyError(withStatus(401)).code, "AUTH_ERROR", "401");
assert.equal(classifyError(withStatus(403)).code, "AUTH_ERROR", "403");
assert.equal(classifyError(withStatus(500)).code, "SERVER_ERROR", "500");
assert.equal(classifyError(withStatus(404)).code, "SERVER_ERROR", "other statuses -> SERVER_ERROR");

{
	const abort = new Error("The operation was aborted");
	abort.name = "AbortError";
	assert.equal(classifyError(abort).code, "TIMEOUT", "AbortError -> TIMEOUT");
	const timeoutName = new Error("x");
	timeoutName.name = "TimeoutError";
	assert.equal(classifyError(timeoutName).code, "TIMEOUT", "TimeoutError -> TIMEOUT");
	assert.equal(classifyError(new Error("request timeout exceeded")).code, "TIMEOUT", "timeout message -> TIMEOUT");
	assert.equal(classifyError(new Error("ECONNRESET")).code, "NETWORK_ERROR", "fallback -> NETWORK_ERROR");
	const already = new SearchError("x", "RATE_LIMITED");
	assert.equal(classifyError(already), already, "SearchError passes through unchanged");
}

console.log("OK client self-test passed");

describe("search client selftest", async () => {
	it("passes", async () => {});
});
