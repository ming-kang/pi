import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { CustomEntry, SessionEntry } from "../src/core/session-manager.ts";
import cachedCompactionExtension from "../src/extensions/cached-compaction/index.ts";
import { type CachedCompactionCard, renderCachedCompactionEntry } from "../src/extensions/cached-compaction/render.ts";
import { checkpointSummary, keptStart } from "../src/extensions/cached-compaction/summary.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
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
			expect(fixture.sessionManager.getBranch().at(-1)).toMatchObject({
				type: "custom",
				customType: "cached-compaction",
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

	it("renders the card as a one-line footnote that expands into the prompt breakdown", () => {
		initTheme("dark");
		const render = (data: CachedCompactionCard, expanded: boolean) => {
			const entry: CustomEntry<CachedCompactionCard> = {
				type: "custom",
				id: "card",
				parentId: "compaction",
				timestamp: "2026-10-31T00:00:00Z",
				customType: "cached-compaction",
				data,
			};
			const lines = renderCachedCompactionEntry(entry, { expanded }, theme)!.render(120);
			return lines.map((line) => stripAnsi(line).trimEnd());
		};
		const automatic = {
			reason: "threshold",
			cacheRead: 641_200,
			input: 3_100,
			cacheWrite: 4_500,
			output: 2_800,
			durationMs: 18_400,
		} as const;

		expect(render(automatic, false)).toEqual([" └ from cache · auto · CH 98.8% · ↓2.8k · 18s"]);
		expect(render(automatic, true)).toEqual([
			" └ from cache · auto · CH 98.8% · 18s",
			"   prompt 649k = R641k cached + W4.5k written + ↑3.1k uncached",
			"   output ↓2.8k",
		]);
		expect(render({ ...automatic, reason: "manual", cacheRead: 0, cacheWrite: 0, input: 900 }, true)).toEqual([
			" └ from cache · manual · 18s",
			"   prompt 900 = ↑900 uncached",
			"   output ↓2.8k",
		]);
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
