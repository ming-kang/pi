import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { formatRunSummary } from "../src/extensions/run-summary/format.ts";
import runSummary from "../src/extensions/run-summary/index.ts";
import { RUN_SUMMARY_ENTRY_TYPE, readRunSummaryRecord } from "../src/extensions/run-summary/record.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

describe("run summary formatting", () => {
	it("uses the Tasks duration style and a local completion timestamp", () => {
		const startedAt = new Date(2026, 9, 28, 13, 12, 22).getTime();
		const finishedAt = new Date(2026, 9, 28, 13, 14, 14).getTime();
		expect(formatRunSummary(startedAt, finishedAt)).toBe("Worked for 1m 52s · Done 2026/10/28 13:14");
		expect(formatRunSummary(startedAt, finishedAt, "stopped")).toBe("Worked for 1m 52s · Stopped 2026/10/28 13:14");
	});
});

describe("run summary lifecycle", () => {
	it("does not settle before steering and adds one note after the continuous run", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to steer",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const notes: Array<{ key: string; text: string; afterEntryId: string }> = [];
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [runSummary],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				addTranscriptNote(key, text, options) {
					notes.push({ key, text, afterEntryId: options.afterEntryId });
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished after steering"),
		]);

		const prompting = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("adjust the current work");
		expect(notes).toEqual([]);
		expect(harness.sessionManager.getBranch().filter((entry) => readRunSummaryRecord(entry))).toHaveLength(0);

		releaseTool();
		await prompting;

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(notes).toHaveLength(1);
		const leaf = harness.sessionManager.getLeafEntry();
		if (!leaf) throw new Error("missing run record leaf");
		const record = readRunSummaryRecord(leaf);
		expect(record).toBeDefined();
		expect(notes[0]).toMatchObject({ afterEntryId: record?.afterEntryId });
		expect(notes[0]?.key).toBe(`run-summary:${record?.afterEntryId}`);
		expect(notes[0]?.text).toMatch(/^Worked for .+ · Done \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
		expect(notes[0]?.text).not.toContain("TPS");
		expect(record?.outcome).toBe("done");
	});

	it("closes an interrupted run with Stopped before the next prompt", async () => {
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for cancellation",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				if (!signal) throw new Error("expected an abort signal");
				markToolStarted();
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "cancelled" }], details: {} };
			},
		};
		const notes: string[] = [];
		const harness = await createHarness({ tools: [waitTool], extensionFactories: [runSummary] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				addTranscriptNote(_key, text) {
					notes.push(text);
				},
			}),
		});
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const prompting = harness.session.prompt("start");
		await toolStarted;
		harness.session.abort();
		await prompting;

		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/^Worked for .+ · Stopped \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);

		harness.appendResponses([fauxAssistantMessage("next response")]);
		await harness.session.prompt("next prompt");
		expect(notes).toHaveLength(2);
		expect(notes[1]).toMatch(/^Worked for .+ · Done \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
		expect(harness.sessionManager.getBranch().filter((entry) => readRunSummaryRecord(entry))).toHaveLength(2);
	});

	it("restores records after reload and branch navigation without writing duplicates", async () => {
		const notes: Array<{ key: string; text: string; afterEntryId: string }> = [];
		const harness = await createHarness({ extensionFactories: [runSummary] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				addTranscriptNote(key, text, options) {
					notes.push({ key, text, afterEntryId: options.afterEntryId });
				},
			}),
		});
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("start");

		const recordEntry = harness.sessionManager.getLeafEntry();
		if (!recordEntry) throw new Error("missing run record");
		const record = readRunSummaryRecord(recordEntry);
		if (!record) throw new Error("invalid run record");
		const originalNote = notes[0];
		expect(originalNote).toBeDefined();

		notes.length = 0;
		await harness.session.reload();
		expect(notes).toEqual([originalNote]);

		await harness.session.navigateTree(record.afterEntryId, { summarize: false });
		notes.length = 0;
		await harness.session.navigateTree(recordEntry.id, { summarize: false });
		expect(notes).toEqual([originalNote]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_SUMMARY_ENTRY_TYPE),
		).toHaveLength(1);
	});
});

describe("interactive transcript notes", () => {
	it("adds an idempotent dim note after the current leaf", () => {
		initTheme("dark");
		const sessionManager = SessionManager.inMemory();
		const afterEntryId = sessionManager.appendMessage(fauxAssistantMessage("done"));
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			extensionTranscriptNotes: new Map(),
			hasRenderedTranscript: true,
			transcriptNotesRefreshScheduled: false,
			runtimeHost: { session: { sessionManager, isIdle: true } },
			chatContainer: new Container(),
			outputPad: 1,
			ui: { requestRender: vi.fn() },
		});
		const addNote = Reflect.get(InteractiveMode.prototype, "addExtensionTranscriptNote") as (
			this: typeof context,
			key: string,
			text: string,
			options: { afterEntryId: string },
		) => void;

		addNote.call(context, "run", "Worked for 8s", { afterEntryId });
		addNote.call(context, "run", "duplicate", { afterEntryId });

		expect(context.extensionTranscriptNotes.size).toBe(1);
		expect(stripAnsi(context.chatContainer.render(100).join("\n"))).toContain("Worked for 8s");
		expect(context.chatContainer.render(100).join("\n")).not.toContain("duplicate");
	});

	it("coalesces historical note restoration into one transcript rebuild", async () => {
		const sessionManager = SessionManager.inMemory();
		const first = sessionManager.appendMessage(fauxAssistantMessage("first"));
		sessionManager.appendMessage(fauxAssistantMessage("current leaf"));
		const session = { sessionManager, isIdle: true };
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			extensionTranscriptNotes: new Map(),
			hasRenderedTranscript: true,
			transcriptNotesRefreshScheduled: false,
			runtimeHost: { session },
			rebuildTranscriptWithNotes: vi.fn(),
		});
		const addNote = Reflect.get(InteractiveMode.prototype, "addExtensionTranscriptNote") as (
			this: typeof context,
			key: string,
			text: string,
			options: { afterEntryId: string },
		) => void;

		addNote.call(context, "first", "first note", { afterEntryId: first });
		addNote.call(context, "second", "second note", { afterEntryId: first });
		await Promise.resolve();

		expect(context.rebuildTranscriptWithNotes).toHaveBeenCalledTimes(1);
	});

	it("reinserts each note immediately after its anchor when entries are rebuilt", () => {
		const sessionManager = SessionManager.inMemory();
		const first = sessionManager.appendMessage(fauxAssistantMessage("first"));
		sessionManager.appendMessage(fauxAssistantMessage("second"));
		const note = { key: "run", text: "Worked for 8s", afterEntryId: first };
		const context = {
			renderer: {},
			extensionTranscriptNotes: new Map([["run", note]]),
			renderSessionItems: vi.fn(),
		};
		const render = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof context,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;

		render.call(context, sessionManager.getBranch());

		const items = context.renderSessionItems.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(items[0]).toMatchObject({ role: "assistant" });
		expect(items[1]).toEqual({ type: "transcript_note", ...note });
		expect(items[2]).toMatchObject({ role: "assistant" });
	});
});
