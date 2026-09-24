import { describe, expect, it, vi } from "vitest";
import type { EditorSubmitHandler, TerminalInputHandler } from "../src/core/extensions/index.ts";
import { InteractiveEditorHost } from "../src/modes/interactive/editor-host.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const methods = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(): void;
	handleFollowUp(): Promise<void>;
};

function createHost() {
	let draft = "";
	const host = {
		defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
		editor: {
			getText: () => draft,
			getExpandedText: () => draft.replace("[paste]", "expanded paste"),
			setText: vi.fn((text: string) => {
				draft = text;
			}),
			addToHistory: vi.fn(),
			onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		},
		editorHost: undefined as unknown as InteractiveEditorHost,
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		isExtensionCommand: vi.fn(() => false),
		queueCompactionMessage: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		onInputCallback: vi.fn(),
		pendingUserInputs: [] as string[],
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		showSettingsSelector: vi.fn(),
		handleBashCommand: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		isBashMode: false,
		addHandler(handler: EditorSubmitHandler) {
			return host.editorHost.onSubmit(handler);
		},
	};
	host.editorHost = new InteractiveEditorHost({
		isSessionCommand: (name) => ["command", "template", "skill:example"].includes(name),
		getEditor: () => host.editor,
		getFocusedComponent: () => host.editor,
		hasOverlay: () => false,
		addTerminalInputListener: () => () => {},
		setEditorText: (text) => host.editor.setText(text),
		requestRender: () => host.ui.requestRender(),
		showError: (message) => host.showError(message),
	});
	methods.setupEditorSubmitHandler.call(host);
	// The follow-up key falls through to the active editor's Enter when idle.
	host.editor.onSubmit = host.defaultEditor.onSubmit;
	return host;
}

describe("interactive editor submit interception", () => {
	it.each(["idle", "streaming", "compacting"])(
		"claims Enter and follow-up input before history and queues while %s",
		async (state) => {
			for (const mode of ["steer", "followUp"] as const) {
				const host = createHost();
				host.session.isStreaming = state === "streaming";
				host.session.isCompacting = state === "compacting";
				const intercept = vi.fn<EditorSubmitHandler>(() => ({ handled: true }));
				host.addHandler(intercept);
				host.editor.setText(" private [paste] ");
				if (mode === "steer") await host.defaultEditor.onSubmit!(" private expanded paste ");
				else await methods.handleFollowUp.call(host);
				expect(intercept).toHaveBeenCalledExactlyOnceWith({ text: "private expanded paste", kind: "prompt", mode });
				expect(host.session.prompt).not.toHaveBeenCalled();
				expect(host.queueCompactionMessage).not.toHaveBeenCalled();
				expect(host.onInputCallback).not.toHaveBeenCalled();
				expect(host.editor.addToHistory).not.toHaveBeenCalled();
				expect(host.editor.getText()).toBe("");
			}
		},
	);

	it("offers a declined idle follow-up once, then submits it like Enter", async () => {
		const host = createHost();
		const decline = vi.fn<EditorSubmitHandler>(() => undefined);
		host.addHandler(decline);
		host.editor.setText("main question");
		await methods.handleFollowUp.call(host);
		expect(decline).toHaveBeenCalledExactlyOnceWith({ text: "main question", kind: "prompt", mode: "followUp" });
		expect(host.onInputCallback).toHaveBeenCalledWith("main question");

		// The next Enter is a new submission and is offered again.
		await host.defaultEditor.onSubmit!("main question");
		expect(decline).toHaveBeenLastCalledWith({ text: "main question", kind: "prompt", mode: "steer" });
		expect(decline).toHaveBeenCalledTimes(2);
	});

	it("restores a busy draft synchronously and fails closed if an interceptor throws", async () => {
		const host = createHost();
		const unsubscribe = host.addHandler((event) => ({ handled: true, editorText: event.text }));
		await host.defaultEditor.onSubmit!("keep my question");
		expect(host.editor.getText()).toBe("keep my question");
		unsubscribe();
		host.addHandler(() => {
			throw new Error("broken panel");
		});
		await host.defaultEditor.onSubmit!("private input");
		expect(host.editor.getText()).toBe("private input");
		expect(host.showError).toHaveBeenCalledWith(expect.stringContaining("broken panel"));
		expect(host.onInputCallback).not.toHaveBeenCalled();
		expect(host.session.prompt).not.toHaveBeenCalled();
	});

	it("classifies existing commands, templates, skills and shell input without swallowing them", async () => {
		const host = createHost();
		for (const command of ["/settings", "/model example", "/command", "/template", "/skill:example", "/debug"]) {
			expect(host.editorHost.classify(command)).toBe("command");
		}
		expect(host.editorHost.classify("/unknown is part of my question")).toBe("prompt");
		expect(host.editorHost.classify("!echo hello")).toBe("bash");
		expect(host.editorHost.classify("!!echo hello")).toBe("bash");
		host.addHandler((event) => (event.kind === "prompt" ? { handled: true } : undefined));
		host.editor.setText("/settings");
		await methods.handleFollowUp.call(host);
		expect(host.showSettingsSelector).toHaveBeenCalledOnce();
		await host.defaultEditor.onSubmit!("!echo hello");
		expect(host.handleBashCommand).toHaveBeenCalledWith("echo hello", false);
		expect(host.queueCompactionMessage).not.toHaveBeenCalled();
	});

	it("resumes normal queue routing after the extension generation is replaced", async () => {
		const host = createHost();
		host.addHandler(() => ({ handled: true }));
		host.editorHost.clear();
		host.session.isCompacting = true;
		host.editor.setText("main follow-up");
		await methods.handleFollowUp.call(host);
		expect(host.queueCompactionMessage).toHaveBeenCalledWith("main follow-up", "followUp");
		host.session.isCompacting = false;
		host.session.isStreaming = true;
		await host.defaultEditor.onSubmit!("main steering");
		expect(host.session.prompt).toHaveBeenCalledWith("main steering", { streamingBehavior: "steer" });
	});
});

describe("editor-scoped terminal input", () => {
	it("gives selectors, overlays and autocomplete priority and unsubscribes through the registry", () => {
		let autocomplete = false;
		let overlay = false;
		const editor = { isShowingAutocomplete: () => autocomplete, getCursor: () => ({ line: 1, col: 2 }) };
		let focused: object = editor;
		const listeners = new Set<TerminalInputHandler>();
		const host = new InteractiveEditorHost({
			isSessionCommand: () => false,
			getEditor: () => editor,
			getFocusedComponent: () => focused,
			hasOverlay: () => overlay,
			addTerminalInputListener: (handler) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			setEditorText: () => {},
			requestRender: () => {},
			showError: () => {},
		});
		const handler = vi.fn<TerminalInputHandler>(() => ({ consume: true }));
		const unsubscribe = host.onInput(handler);
		const input = [...listeners][0];
		expect(input("escape")).toEqual({ consume: true });
		focused = {};
		expect(input("escape")).toBeUndefined();
		focused = editor;
		overlay = true;
		expect(input("escape")).toBeUndefined();
		overlay = false;
		autocomplete = true;
		expect(input("escape")).toBeUndefined();
		expect(handler).toHaveBeenCalledOnce();
		expect(host.getCursor()).toEqual({ line: 1, col: 2 });
		unsubscribe();
		expect(listeners.size).toBe(0);
	});
});
