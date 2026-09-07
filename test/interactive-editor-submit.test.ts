import { describe, expect, it, vi } from "vitest";
import type {
	EditorSubmitEvent,
	EditorSubmitHandler,
	TerminalInputHandler,
	TerminalInputOptions,
} from "../src/core/extensions/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const methods = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(): void;
	handleEditorSubmit(text: string, mode: EditorSubmitEvent["mode"]): Promise<void>;
	handleFollowUp(): Promise<void>;
	interceptEditorSubmit(text: string, mode: EditorSubmitEvent["mode"]): boolean;
	classifyEditorSubmit(text: string): EditorSubmitEvent["kind"];
	addExtensionTerminalInputListener(handler: TerminalInputHandler, options?: TerminalInputOptions): () => void;
	clearExtensionTerminalInputListeners(): void;
};

function createHost() {
	let draft = "";
	const host = {
		handleEditorSubmit: methods.handleEditorSubmit,
		interceptEditorSubmit: methods.interceptEditorSubmit,
		classifyEditorSubmit: methods.classifyEditorSubmit,
		defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
		editor: {
			getText: () => draft,
			getExpandedText: () => draft.replace("[paste]", "expanded paste"),
			setText: vi.fn((text: string) => {
				draft = text;
			}),
			addToHistory: vi.fn(),
		},
		extensionEditorSubmitHandlers: new Set<EditorSubmitHandler>(),
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
			promptTemplates: [{ name: "template" }],
			extensionRunner: { getCommand: (name: string) => (name === "command" ? {} : undefined) },
		},
		skillCommands: new Map([["skill:example", "example"]]),
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
	};
	methods.setupEditorSubmitHandler.call(host);
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
				host.extensionEditorSubmitHandlers.add(intercept);
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

	it("restores a busy draft synchronously and fails closed if an interceptor throws", async () => {
		const host = createHost();
		host.extensionEditorSubmitHandlers.add((event) => ({ handled: true, editorText: event.text }));
		await host.defaultEditor.onSubmit!("keep my question");
		expect(host.editor.getText()).toBe("keep my question");
		host.extensionEditorSubmitHandlers.clear();
		host.extensionEditorSubmitHandlers.add(() => {
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
			expect(methods.classifyEditorSubmit.call(host, command)).toBe("command");
		}
		expect(methods.classifyEditorSubmit.call(host, "/unknown is part of my question")).toBe("prompt");
		expect(methods.classifyEditorSubmit.call(host, "!echo hello")).toBe("bash");
		expect(methods.classifyEditorSubmit.call(host, "!!echo hello")).toBe("bash");
		host.extensionEditorSubmitHandlers.add((event) => (event.kind === "prompt" ? { handled: true } : undefined));
		host.session.isCompacting = true;
		host.editor.setText("/settings");
		await methods.handleFollowUp.call(host);
		expect(host.showSettingsSelector).toHaveBeenCalledOnce();
		await host.defaultEditor.onSubmit!("!echo hello");
		expect(host.handleBashCommand).toHaveBeenCalledWith("echo hello", false);
		expect(host.queueCompactionMessage).not.toHaveBeenCalled();
	});

	it("resumes normal queue routing after the interceptor is removed", async () => {
		const host = createHost();
		host.extensionEditorSubmitHandlers.add(() => ({ handled: true }));
		host.extensionEditorSubmitHandlers.clear();
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
	it("gives selectors, overlays and autocomplete priority and removes the subscription on teardown", () => {
		let autocomplete = false;
		let overlay = false;
		const editor = { isShowingAutocomplete: () => autocomplete };
		let focused: object = editor;
		const listeners = new Set<TerminalInputHandler>();
		const host = {
			editor,
			renderer: { getFocusedComponent: () => focused },
			ui: {
				hasOverlay: () => overlay,
				addInputListener: (handler: TerminalInputHandler) => {
					listeners.add(handler);
					return () => listeners.delete(handler);
				},
			},
			extensionTerminalInputSubscriptions: new Set<{ handler: TerminalInputHandler; unsubscribe: () => void }>(),
		};
		const handler = vi.fn<TerminalInputHandler>(() => ({ consume: true }));
		methods.addExtensionTerminalInputListener.call(host, handler, { scope: "editor" });
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
		methods.clearExtensionTerminalInputListeners.call(host);
		expect(listeners.size).toBe(0);
		expect(host.extensionTerminalInputSubscriptions.size).toBe(0);
	});
});
