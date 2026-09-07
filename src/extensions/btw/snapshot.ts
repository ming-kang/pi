import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextSnapshot } from "../../core/extensions/index.ts";
import { BTW_REMINDER, MAX_SNAPSHOT_CHARS, UNKNOWN_TOOL_RESULT } from "./constants.ts";

/** Complete only the open tail exchange; settled messages remain byte-for-byte intact. */
export function createBtwMessages(snapshot: ContextSnapshot): Message[] {
	if (JSON.stringify([snapshot.systemPrompt, snapshot.tools, snapshot.messages]).length > MAX_SNAPSHOT_CHARS) {
		throw new Error("The main context is too large for BTW. Compact the main conversation, then reopen /btw.");
	}
	const messages = structuredClone(snapshot.messages);
	const pending = new Map<string, ToolCall>();
	for (const message of messages) {
		if (message.role === "assistant") {
			pending.clear();
			for (const part of message.content) {
				if (part.type === "toolCall") pending.set(part.id, part);
			}
		} else if (message.role === "toolResult") {
			pending.delete(message.toolCallId);
		}
	}
	for (const call of pending.values()) {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: UNKNOWN_TOOL_RESULT }],
			isError: true,
			timestamp: snapshot.capturedAt,
		};
		messages.push(result);
	}
	messages.push({ role: "user", content: [{ type: "text", text: BTW_REMINDER }], timestamp: snapshot.capturedAt });
	return messages;
}
