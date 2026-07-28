import { describe, expect, it } from "vitest";
import { sanitizeInputItemsForCodex } from "../src/extensions/router/stream.ts";

describe("router Codex payload sanitization", () => {
	it("omits replayed item ids while preserving Codex continuity fields", () => {
		const input = [
			{
				type: "reasoning",
				id: "item_8eac24fc0537bfab7c7e0155",
				status: "completed",
				summary: [{ type: "summary_text", text: "reasoning" }],
				encrypted_content: "opaque-reasoning",
			},
			{
				type: "message",
				id: "msg_assistant",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "done", annotations: [] }],
			},
			{
				type: "function_call",
				id: "fc_call",
				call_id: "call_123",
				name: "read",
				arguments: "{}",
				status: "completed",
			},
			{
				type: "function_call_output",
				id: "fco_result",
				call_id: "call_123",
				output: "ok",
				status: "completed",
			},
			{
				type: "local_shell_call",
				id: "lsh_call",
				call_id: "call_456",
				status: "completed",
				action: { type: "exec", command: ["echo", "ok"] },
			},
			{
				type: "web_search_call",
				id: "ws_call",
				status: "completed",
			},
		];

		sanitizeInputItemsForCodex(input);

		for (const item of input) {
			expect(item).not.toHaveProperty("id");
		}
		expect(input[0]).toMatchObject({
			type: "reasoning",
			encrypted_content: "opaque-reasoning",
		});
		expect(input[0]).not.toHaveProperty("status");
		expect(input[1]).not.toHaveProperty("status");
		expect(input[1]?.content?.[0]).not.toHaveProperty("annotations");
		expect(input[2]).toMatchObject({ call_id: "call_123" });
		expect(input[2]).not.toHaveProperty("status");
		expect(input[3]).toMatchObject({ call_id: "call_123" });
		expect(input[3]).not.toHaveProperty("status");
		expect(input[4]).toMatchObject({ call_id: "call_456", status: "completed" });
		expect(input[5]).toMatchObject({ status: "completed" });
	});

	it("preserves ids that are semantic references rather than ResponseItem identities", () => {
		const input = [
			{ type: "item_reference", id: "rs_stored_reasoning" },
			{
				type: "local_shell_call_output",
				id: "lsh_originating_call",
				output: "ok",
				status: "completed",
			},
			{
				type: "message",
				id: "msg_assistant",
				role: "assistant",
				content: [{ type: "output_text", id: "nested_content_id", text: "done", annotations: [] }],
			},
			{ type: "relay_extension_item", id: "relay_semantic_id" },
		];

		sanitizeInputItemsForCodex(input);

		expect(input[0]).toEqual({ type: "item_reference", id: "rs_stored_reasoning" });
		expect(input[1]).toMatchObject({
			type: "local_shell_call_output",
			id: "lsh_originating_call",
			status: "completed",
		});
		expect(input[2]).not.toHaveProperty("id");
		expect(input[2]?.content?.[0]).toMatchObject({ id: "nested_content_id" });
		expect(input[2]?.content?.[0]).not.toHaveProperty("annotations");
		expect(input[3]).toEqual({ type: "relay_extension_item", id: "relay_semantic_id" });
	});

	it("ignores non-array payload input", () => {
		const input = { type: "reasoning", id: "item_reasoning" };

		sanitizeInputItemsForCodex(input);

		expect(input.id).toBe("item_reasoning");
	});
});
