/**
 * A subagent session is a single turn: one prompt, then only assistant and tool
 * result entries. That leaves the fewest possible cut points, so a fat tail used
 * to degrade findCutPoint into "keep everything" and left nothing to compact.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, findCutPoint, prepareCompaction } from "../src/core/compaction/index.ts";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
});

function nextIds(): { id: string; parentId: string | null } {
	const id = `test-id-${entryCounter++}`;
	const parentId = lastId;
	lastId = id;
	return { id, parentId };
}

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", ...nextIds(), timestamp: new Date().toISOString(), message };
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		...nextIds(),
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
}

function createUserMessage(text: string): SessionMessageEntry {
	return createMessageEntry({ role: "user", content: text, timestamp: Date.now() });
}

/** Assistant turn that calls a tool; its result follows as a separate entry. */
function createToolCall(toolCallId: string, text: string): SessionMessageEntry {
	return createMessageEntry({
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: "grep", arguments: { pattern: "x" } },
		],
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage);
}

/** Tool result of `chars` characters; never a valid cut point. */
function createToolResult(toolCallId: string, chars: number): SessionMessageEntry {
	return createMessageEntry({
		role: "toolResult",
		toolCallId,
		toolName: "grep",
		content: [{ type: "text", text: "x".repeat(chars) }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage);
}

describe("prepareCompaction for a single-turn session with a fat tail", () => {
	it("summarizes the turn prefix on the first compaction", () => {
		const entries: SessionEntry[] = [
			createUserMessage("Review the redesigned todo extension."),
			createToolCall("t1", "searching"),
			createToolResult("t1", 40_000),
			createToolCall("t2", "searching more"),
			createToolResult("t2", 100_000),
		];

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		expect(preparation!.isSplitTurn).toBe(true);
		// Nothing precedes the only turn, so the whole prefix goes to the turn summary.
		expect(preparation!.messagesToSummarize).toHaveLength(0);
		expect(preparation!.turnPrefixMessages.length).toBeGreaterThan(0);
	});

	it("summarizes the retained history on a second compaction", () => {
		const u = createUserMessage("Review the redesigned todo extension.");
		const a1 = createToolCall("t1", "a1");
		const r1 = createToolResult("t1", 40_000);
		const a2 = createToolCall("t2", "a2");
		const r2 = createToolResult("t2", 40_000);
		const compaction1 = createCompactionEntry("First summary", a2.id);
		const a3 = createToolCall("t3", "a3");
		const r3 = createToolResult("t3", 100_000);

		const preparation = prepareCompaction([u, a1, r1, a2, r2, compaction1, a3, r3], DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		expect(preparation!.firstKeptEntryId).toBe(a3.id);
		expect(preparation!.messagesToSummarize.length).toBeGreaterThan(0);
		expect(preparation!.previousSummary).toBe("First summary");
	});

	it("still keeps everything when the tail fits the budget", () => {
		const entries: SessionEntry[] = [
			createUserMessage("Review the redesigned todo extension."),
			createToolCall("t1", "searching"),
			createToolResult("t1", 2_000),
		];

		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
		expect(result.firstKeptEntryIndex).toBe(0);
		// Everything fits, so there is genuinely nothing to compact.
		expect(prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});
});
