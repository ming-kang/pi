import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { CustomEntry, SessionEntry } from "../src/core/session-manager.ts";
import cachedCompactionExtension from "../src/extensions/cached-compaction/index.ts";
import { type CachedCompactionCard, renderCachedCompactionEntry } from "../src/extensions/cached-compaction/render.ts";
import { checkpointSummary, keptStart } from "../src/extensions/cached-compaction/summary.ts";
import { keyHint, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
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

	it("declares the prompt and tools when the snapshot carries no system message", async () => {
		// A `context_with_system` handler can drop the leading system message, so the snapshot no
		// longer carries the prompt and the tool declarations the compaction request needs.
		const dropSystem = (pi: ExtensionAPI) => {
			pi.on("context_with_system", (event) => {
				event.messages.splice(0, event.messages.length, ...event.messages.filter((m) => m.role !== "system"));
				return { messages: event.messages };
			});
		};
		const requests: Context[] = [];
		const fixture = await createBtwTestSession({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensions: [dropSystem, cachedCompactionExtension],
			tools: [
				{
					name: "note",
					label: "Note",
					description: "Write a note",
					parameters: Type.Object({ text: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "noted" }], details: {} }),
				},
			],
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
			const system = requests[1]!.messages[0] as {
				role: string;
				content?: string;
				toolsAdded?: Array<{ name: string }>;
			};
			expect(system?.role).toBe("system");
			expect(system.content?.length ?? 0).toBeGreaterThan(0);
			expect(system.toolsAdded?.map((tool) => tool.name)).toEqual(["note"]);
			expect(requests[1]!.messages[1]).toMatchObject({ role: "user" });
			const instruction = requests[1]!.messages.at(-1);
			expect(instruction?.role).toBe("user");
			expect(JSON.stringify(instruction)).toContain("<kept-start>");
		} finally {
			await fixture.cleanup();
		}
	});

	it("does not append its card when a later handler overrides the compaction summary", async () => {
		const override = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", (event) => ({
				compaction: {
					summary: "## Goal\nOverridden by the later handler.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: undefined,
					details: undefined,
				},
			}));
		};
		const fixture = await createBtwTestSession({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensions: [cachedCompactionExtension, override],
			stream: (_model, context) => {
				const calls = context.messages.filter((message) => message.role === "assistant").length;
				return btwDone(btwResponse(calls === 1 ? "working on it" : "## Goal\nDiscarded summary."));
			},
		});
		try {
			await fixture.session.prompt("remember the goal");
			const result = await fixture.session.compact("Focus on tests");

			expect(result?.summary).toBe("## Goal\nOverridden by the later handler.");
			expect(
				fixture.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "cached-compaction"),
			).toEqual([]);
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
			const lines = renderCachedCompactionEntry(entry, { expanded, outputPad: 1, keyText, keyHint }, theme)!.render(
				120,
			);
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

		expect(render(automatic, false)).toEqual([" From cache · auto · CH 98.8% · ↓2.8k · 18s"]);
		expect(render(automatic, true)).toEqual([
			" From cache · auto · CH 98.8% · 18s",
			" Prompt 649k = R641k cached + W4.5k written + ↑3.1k uncached",
			" Output ↓2.8k",
		]);
		expect(render({ ...automatic, reason: "manual", cacheRead: 0, cacheWrite: 0, input: 900 }, true)).toEqual([
			" From cache · manual · 18s",
			" Prompt 900 = ↑900 uncached",
			" Output ↓2.8k",
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

	it("does not add leading blank lines when the summary body is empty", () => {
		const result = checkpointSummary(
			"<read-files>\nold.ts\n</read-files>",
			{ read: new Set(["new.ts"]), written: new Set(), edited: new Set() },
			[],
		);
		expect(result.summary).toBe("<read-files>\nnew.ts\n</read-files>");
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
