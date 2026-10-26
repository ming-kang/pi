import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import cachedCompactionExtension from "../src/extensions/cached-compaction/index.ts";
import { checkpointSummary, keptStart } from "../src/extensions/cached-compaction/summary.ts";
import { btwDone, btwResponse } from "./helpers/btw.ts";
import { createBtwTestSession } from "./helpers/btw-session.ts";

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	} as SessionEntry;
}

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function toolCall(timestamp: number): AgentMessage {
	return btwResponse("", {
		content: [{ type: "toolCall", id: `tool-${timestamp}`, name: "bash", arguments: { command: "ls" } }],
		timestamp,
	});
}

describe("cached compaction", () => {
	it("summarizes the full snapshot and persists native compaction state and a display-only card", async () => {
		const requests: Context[] = [];
		const fixture = await createBtwTestSession({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensions: [cachedCompactionExtension],
			stream: (_model, context) => {
				requests.push(structuredClone(context));
				return btwDone(btwResponse(requests.length === 1 ? "working on it" : "## Goal\nFinish the tests."));
			},
		});
		try {
			await fixture.session.prompt("remember the goal");
			const result = await fixture.session.compact("Focus on tests");

			expect(result?.summary).toBe("## Goal\nFinish the tests.");
			expect(requests).toHaveLength(2);
			expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
			expect(requests[1].messages.at(-2)).toMatchObject({ role: "assistant" });
			const instruction = requests[1].messages.at(-1);
			expect(instruction?.role).toBe("user");
			expect(JSON.stringify(instruction)).toContain("<kept-start>");
			expect(JSON.stringify(instruction)).toContain("Additional focus from the user:\\nFocus on tests");

			const branch = fixture.sessionManager.getBranch();
			expect(branch.find((entry) => entry.type === "compaction")).toMatchObject({
				summary: "## Goal\nFinish the tests.",
				fromHook: true,
				usage: expect.objectContaining({ cacheRead: 100 }),
			});
			expect(
				fixture.sessionManager
					.buildSessionProjection()
					.messages.some((message) => message.role === "compactionSummary"),
			).toBe(true);
			await vi.waitFor(() => {
				expect(
					fixture.sessionManager
						.getBranch()
						.some((entry) => entry.type === "custom" && entry.customType === "cached-compaction"),
				).toBe(true);
			});
			expect(
				fixture.sessionManager
					.buildSessionProjection()
					.entries.filter((entry) => entry.sourceEntry.type === "custom")
					.every((entry) => entry.messages.length === 0),
			).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	});

	it("falls back after an invalid summary but does not retry after cancellation", async () => {
		let calls = 0;
		const fallback = await createBtwTestSession({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensions: [cachedCompactionExtension],
			stream: () => {
				calls++;
				if (calls === 2) return btwDone(btwResponse("partial", { stopReason: "length" }));
				return btwDone(btwResponse(calls === 1 ? "working" : "## Goal\nNative fallback"));
			},
		});
		try {
			await fallback.session.prompt("test fallback");
			await expect(fallback.session.compact()).resolves.toMatchObject({
				summary: expect.stringContaining("## Goal\nNative fallback"),
			});
			expect(calls).toBe(3);
		} finally {
			await fallback.cleanup();
		}

		calls = 0;
		const cancelled = await createBtwTestSession({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensions: [cachedCompactionExtension],
			stream: () => {
				calls++;
				return btwDone(btwResponse(calls === 1 ? "working" : "", { stopReason: calls === 1 ? "stop" : "aborted" }));
			},
		});
		try {
			await cancelled.session.prompt("test cancellation");
			await expect(cancelled.session.compact()).rejects.toThrow("Compaction cancelled");
			expect(calls).toBe(2);
		} finally {
			await cancelled.cleanup();
		}
	});

	it("marks repeated kept tool calls from the end and rejects an unknown boundary", () => {
		const start = user("start", 1);
		const first = toolCall(2);
		const second = toolCall(3);
		const entries = [messageEntry("a", null, start), messageEntry("b", "a", first), messageEntry("c", "b", second)];
		const conversation = [start, first, second] as Message[];
		expect(keptStart(entries, "b", conversation)).toEqual({
			text: '[tool call: bash {"command":"ls"}]',
			fromEnd: 2,
			count: 2,
		});
		expect(keptStart(entries, "missing", conversation)).toBeUndefined();
	});

	it("carries file lists across extension and native compactions without duplicating model tags", () => {
		const previous = {
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			summary: "old",
			firstKeptEntryId: "a",
			tokensBefore: 10,
			details: { readFiles: ["old-read.ts"], modifiedFiles: ["old-edit.ts"] },
		} as SessionEntry;
		const result = checkpointSummary(
			"## Goal\nFinish\n\n<modified-files>\nold-edit.ts\n</modified-files>",
			{ read: new Set(["new-read.ts", "new-edit.ts"]), written: new Set(), edited: new Set(["new-edit.ts"]) },
			[previous],
		);
		expect(result.details).toEqual({
			readFiles: ["new-read.ts", "old-read.ts"],
			modifiedFiles: ["new-edit.ts", "old-edit.ts"],
		});
		expect(result.summary.match(/<modified-files>/g)).toHaveLength(1);
		expect(result.summary).toContain("old-edit.ts");
	});
});
