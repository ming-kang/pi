/** Conversation compaction: keep the system prompt, the problem statement, and the newest tool exchange. */
import type { ChatMessage } from "./client.ts";

/** Index of the newest tool result and of the assistant call it answers, or -1 for each when absent. */
function newestExchange(messages: ChatMessage[]): { resultIdx: number; callIdx: number } {
	let resultIdx = -1;
	let refId: string | undefined;
	for (let i = messages.length - 1; i >= 2; i--) {
		const m = messages[i]!;
		if (m.role === 4 && m.ref_call_id) {
			resultIdx = i;
			refId = m.ref_call_id;
			break;
		}
	}
	if (refId === undefined) return { resultIdx, callIdx: -1 };
	for (let i = resultIdx - 1; i >= 2; i--) {
		const m = messages[i]!;
		if (m.role === 2 && m.tool_call_id === refId) return { resultIdx, callIdx: i };
	}
	return { resultIdx, callIdx: -1 };
}

/**
 * Drop what the next planning round does not need, in place: the repo map becomes a pointer and
 * older tool exchanges are removed. Returns false when the conversation is already minimal, so
 * callers can skip the retry they were about to attempt.
 */
export function trimMessages(messages: ChatMessage[], query: string): boolean {
	if (messages.length < 2) return false;
	const system = messages[0]!;
	const user = messages[1]!;

	const { resultIdx, callIdx } = newestExchange(messages);
	const tailStart =
		resultIdx === -1 ? Math.max(2, messages.length - 2) : callIdx !== -1 ? callIdx : Math.max(2, resultIdx - 1);
	const tail = messages.slice(tailStart);

	const compactUser: ChatMessage = user.content.includes("Repo Map")
		? {
				...user,
				content: `Problem Statement: ${query}\n\nRepo Map: (omitted to reduce payload — use tree/rg to explore structure if needed).`,
			}
		: user;
	const didCompact = compactUser.content.length < user.content.length;
	const droppedHistory = tailStart > 2;
	if (!didCompact && !droppedHistory) return false;

	messages.length = 0;
	messages.push(
		system,
		compactUser,
		{ role: 1, content: "[Context trimmed to reduce payload. Continue from the most recent tool results below.]" },
		...tail,
	);
	return true;
}
