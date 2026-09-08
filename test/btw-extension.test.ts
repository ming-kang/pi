import { readdirSync, readFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import {
	type Component,
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSubmitHandler, ExtensionUIContext, TerminalInputHandler } from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import btwExtension from "../src/extensions/btw/index.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { btwDone, btwPending, btwResponse } from "./helpers/btw.ts";
import { createBtwTestSession } from "./helpers/btw-session.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

async function bindUi(fixture: Awaited<ReturnType<typeof createBtwTestSession>>) {
	const submitHandlers = new Set<EditorSubmitHandler>();
	const keyHandlers = new Set<TerminalInputHandler>();
	const tui = new TuiMainScreen(new VirtualTerminal(120, 30));
	const editor = new CustomEditor(tui, getEditorTheme(), getKeybindings() as KeybindingsManager);
	tui.setFocus(editor);
	let widget: (Component & { dispose?(): void }) | undefined;
	const ui: ExtensionUIContext = {
		...fixture.session.extensionRunner.getUIContext(),
		notify: vi.fn(),
		setWidget: (_key, factory) => {
			widget?.dispose?.();
			widget = typeof factory === "function" ? factory(tui, ui.theme) : undefined;
		},
		onEditorSubmit: (handler) => {
			submitHandlers.add(handler);
			return () => submitHandlers.delete(handler);
		},
		onTerminalInput: (handler, options) => {
			expect(options).toEqual({ scope: "editor" });
			keyHandlers.add(handler);
			return () => keyHandlers.delete(handler);
		},
		getEditorText: () => editor.getExpandedText(),
		getEditorCursor: () => editor.getCursor(),
		setEditorText: (text) => editor.setText(text),
	};
	await fixture.session.bindExtensions({ uiContext: ui, mode: "tui" });
	return {
		ui,
		editor,
		submitHandlers,
		keyHandlers,
		get text() {
			return widget?.render(120).map(stripTerminalSequences).join("\n") ?? "";
		},
		get editorText() {
			return editor.getText();
		},
		get widget() {
			return widget;
		},
		submit(text: string, kind: "prompt" | "command" = "prompt") {
			for (const handler of submitHandlers) {
				const result = handler({ text, kind, mode: "steer" });
				if (result?.handled) {
					editor.setText(result.editorText ?? "");
					return true;
				}
			}
			return false;
		},
		key(data: string) {
			for (const handler of keyHandlers) if (handler(data)?.consume) return true;
			editor.handleInput(data);
			return false;
		},
	};
}

describe("BTW extension lifecycle and persistence", () => {
	const cleanups: Array<() => Promise<void>> = [];
	const originalKeys = getKeybindings();
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()!();
		setKeybindings(originalKeys);
	});

	it("keeps questions and answers out of JSONL, files and main context through follow-up, close and reopen", async () => {
		const requests: Context[] = [];
		const fixture = await createBtwTestSession({
			persist: true,
			extensions: [btwExtension],
			stream: (_model, context) => {
				requests.push(structuredClone({ ...context, tools: [] }));
				return btwDone(
					btwResponse(requests.length === 1 ? "Main answer" : `Private side answer ${requests.length}`),
				);
			},
		});
		const view = await bindUi(fixture);
		cleanups.push(async () => {
			await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await fixture.cleanup();
		});
		await fixture.session.prompt("Main seed");
		const path = fixture.sessionManager.getSessionFile()!;
		const before = readFileSync(path, "utf8");
		const files = readdirSync(fixture.sessionsDirectory);
		const entries = structuredClone(fixture.sessionManager.getEntries());
		// Command invocation through AgentSession is also ephemeral.
		await fixture.session.prompt("/btw Private first question");
		await vi.waitFor(() => expect(view.text).toContain("Private side answer 2"));
		expect(view.submit("Private follow-up")).toBe(true);
		await vi.waitFor(() => expect(view.text).toContain("Private side answer 3"));
		expect(JSON.stringify(requests[2].messages)).toContain("Private first question");
		expect(JSON.stringify(requests[2].messages)).toContain("Private side answer 2");
		expect(view.key("\x1b")).toBe(true);
		expect(view.widget).toBeUndefined();
		expect(view.keyHandlers.size).toBe(0);
		expect(view.submit("/btw", "command")).toBe(true);
		await vi.waitFor(() => expect(view.text).toContain("Ask a side question"));
		expect(view.text).not.toContain("Private first question");
		view.submit("Fresh private question");
		await vi.waitFor(() => expect(view.text).toContain("Private side answer 4"));
		expect(JSON.stringify(requests[3])).not.toContain("Private first question");
		expect(JSON.stringify(requests[3])).not.toContain("Private follow-up");
		expect(fixture.session.messages).toHaveLength(2);
		expect(fixture.sessionManager.getEntries()).toEqual(entries);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readdirSync(fixture.sessionsDirectory)).toEqual(files);
	});

	it("takes the snapshot on empty /btw, restores busy drafts, and discards cancelled turns on close", async () => {
		const requests: Context[] = [];
		let pending: ReturnType<typeof btwPending> | undefined;
		const fixture = await createBtwTestSession({
			persist: true,
			extensions: [btwExtension],
			stream: (_model, context, options) => {
				requests.push(structuredClone({ ...context, tools: [] }));
				if (requests.length <= 2) return btwDone(btwResponse(`main ${requests.length}`));
				pending = btwPending(options?.signal);
				return pending.stream;
			},
		});
		const view = await bindUi(fixture);
		cleanups.push(async () => {
			await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await fixture.cleanup();
		});
		await fixture.session.prompt("source at open");
		await fixture.session.prompt("/btw");
		await fixture.session.prompt("main information after open", { source: "extension" });
		const before = readFileSync(fixture.sessionManager.getSessionFile()!, "utf8");
		view.submit("private streaming question");
		await vi.waitFor(() => expect(pending).toBeDefined());
		expect(JSON.stringify(requests[2])).not.toContain("main information after open");
		expect(view.submit("busy draft")).toBe(true);
		expect(view.editorText).toBe("busy draft");
		expect(requests).toHaveLength(3);
		pending!.text("partial private output");
		await vi.waitFor(() => expect(view.text).toContain("partial private output"));
		expect(view.key("\x03")).toBe(true);
		await vi.waitFor(() => expect(view.text).toContain("Stopped."));
		expect(view.text).toContain("partial private output");
		expect(view.editorText).toBe("busy draft");
		view.key("\x1b");
		expect(view.widget).toBeUndefined();
		expect(view.editorText).toBe("");
		expect(readFileSync(fixture.sessionManager.getSessionFile()!, "utf8")).toBe(before);
	});

	it("drops late results after reopen, tree navigation and reload, including a pending snapshot", async () => {
		const pending: Array<ReturnType<typeof btwPending>> = [];
		const fixture = await createBtwTestSession({
			extensions: [btwExtension],
			stream: () => {
				// Deliberately ignore cancellation to exercise late provider settlement.
				const response = btwPending();
				pending.push(response);
				return response.stream;
			},
		});
		const view = await bindUi(fixture);
		cleanups.push(async () => {
			await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			for (const response of pending) response.finish("late cleanup");
			await fixture.cleanup();
		});
		view.submit("/btw old question", "command");
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		view.submit("/btw new question", "command");
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		pending[0].finish("OLD LATE RESPONSE");
		pending[1].finish("NEW RESPONSE");
		await vi.waitFor(() => expect(view.text).toContain("NEW RESPONSE"));
		expect(view.text).not.toContain("OLD LATE RESPONSE");
		expect(view.text).not.toContain("old question");
		await fixture.session.extensionRunner.emit({ type: "session_tree", newLeafId: "new-leaf", oldLeafId: null });
		expect(view.widget).toBeUndefined();
		expect(view.keyHandlers.size).toBe(0);
		view.submit("/btw", "command");
		// The asynchronous snapshot has not settled yet.
		view.ui.setEditorText("private draft during capture");
		await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		await Promise.resolve();
		expect(view.widget).toBeUndefined();
		expect(view.editorText).toBe("");
		expect(view.submitHandlers.size).toBe(0);
		expect(view.keyHandlers.size).toBe(0);
	});

	it("discards the BTW draft only after successful tree navigation and leaves later main drafts alone", async () => {
		let cancelNavigation = true;
		const fixture = await createBtwTestSession({
			persist: true,
			extensions: [btwExtension, (pi) => pi.on("session_before_tree", () => ({ cancel: cancelNavigation }))],
			stream: () => btwDone(btwResponse("main answer")),
		});
		const view = await bindUi(fixture);
		cleanups.push(async () => {
			await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await fixture.cleanup();
		});
		await fixture.session.prompt("main seed");
		const target = fixture.sessionManager.getBranch().find((entry) => entry.type === "message")!;
		await fixture.session.prompt("/btw");
		view.ui.setEditorText("private BTW draft");
		expect(await fixture.session.navigateTree(target.id)).toMatchObject({ cancelled: true });
		expect(view.widget).toBeDefined();
		expect(view.editorText).toBe("private BTW draft");

		cancelNavigation = false;
		expect(await fixture.session.navigateTree(target.id)).toMatchObject({ cancelled: false });
		expect(view.widget).toBeUndefined();
		expect(view.editorText).toBe("");
		expect(view.keyHandlers.size).toBe(0);
		expect(view.submit("new main prompt")).toBe(false);
		await fixture.session.prompt("new main prompt");
		expect(JSON.stringify(fixture.session.messages)).not.toContain("private BTW draft");
		expect(readFileSync(fixture.sessionManager.getSessionFile()!, "utf8")).not.toContain("private BTW draft");

		view.ui.setEditorText("main draft after BTW closed");
		await fixture.session.navigateTree(target.id);
		expect(view.editorText).toBe("main draft after BTW closed");
		await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(view.editorText).toBe("main draft after BTW closed");
	});

	it("never opens main history for a short panel while retaining multiline draft movement", async () => {
		const fixture = await createBtwTestSession({
			extensions: [btwExtension],
			stream: () => btwDone(btwResponse("short answer")),
		});
		const view = await bindUi(fixture);
		view.editor.addToHistory("MAIN HISTORY ONLY");
		cleanups.push(async () => {
			await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await fixture.cleanup();
		});
		view.submit("/btw", "command");
		await vi.waitFor(() => expect(view.text).toContain("Ask a side question"));
		expect(view.key("\x1b[A")).toBe(true);
		expect(view.key("\x1b[B")).toBe(true);
		expect(view.editorText).toBe("");
		view.submit("short question");
		await vi.waitFor(() => expect(view.text).toContain("short answer"));
		for (let i = 0; i < 3; i++) {
			view.key("\x1b[A");
			view.key("\x1b[B");
		}
		expect(view.editorText).toBe("");
		view.ui.setEditorText("first line\nsecond line");
		view.editor.render(120);
		view.key("\x1b[A");
		expect(view.editor.getCursor().line).toBe(0);
		view.key("\x1b[A");
		expect(view.editor.getCursor().col).toBe(0);
		expect(view.key("\x1b[A")).toBe(true);
		expect(view.editorText).toBe("first line\nsecond line");
		view.key("\x1b[B");
		expect(view.editor.getCursor().line).toBe(1);
		setKeybindings(new KeybindingsManager({ "tui.editor.historyPrevious": "ctrl+p" }));
		expect(view.key("\x10")).toBe(true);
		expect(view.editorText).toBe("first line\nsecond line");
		view.key("\x1b");
		expect(view.key("\x1b[A")).toBe(false);
		expect(view.editorText).toBe("MAIN HISTORY ONLY");
	});

	it("respects remapped keys and lets other commands use the host", async () => {
		setKeybindings(new KeybindingsManager({ "app.btw.close": "ctrl+k", "app.btw.cancel": "ctrl+j" }));
		const fixture = await createBtwTestSession({
			extensions: [btwExtension],
			stream: () => btwDone(btwResponse("ok")),
		});
		const view = await bindUi(fixture);
		cleanups.push(async () => {
			await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await fixture.cleanup();
		});
		view.submit("/btw", "command");
		await vi.waitFor(() => expect(view.text).toContain("Ask a side question"));
		expect(view.text).toContain("Ctrl+K close");
		expect(view.submit("/tree", "command")).toBe(false);
		expect(view.key("\x1b")).toBe(false);
		expect(view.key("\x0b")).toBe(true);
		expect(view.widget).toBeUndefined();
	});
});
