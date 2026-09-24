import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, TerminalInputHandler } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createBackgroundExtension } from "../src/extensions/background/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const previousKeybindings = getKeybindings();
afterEach(() => setKeybindings(previousKeybindings));

/** The bundled background extension with a fake TUI host that records terminal listeners. */
function harness(bindings = new KeybindingsManager()) {
	setKeybindings(bindings);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
	createBackgroundExtension()(pi);
	const listeners = new Set<TerminalInputHandler>();
	const ctx = {
		background: { detachForeground: vi.fn(() => 2), list: () => [], subscribe: () => () => {} },
		abort: vi.fn(),
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
			onTerminalInput: (handler: TerminalInputHandler) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
		},
	};
	const emit = (event: string) => handlers.get(event)?.({}, ctx as unknown as ExtensionContext);
	return { ctx, listeners, emit, input: (data: string) => [...listeners][0]?.(data) };
}

describe("Background detach key", () => {
	it("detaches from any focus through the terminal listener and never aborts the parent", () => {
		const h = harness();
		h.emit("session_start");
		expect(h.input("\x02")).toEqual({ consume: true });
		expect(h.ctx.background.detachForeground).toHaveBeenCalledOnce();
		expect(h.ctx.abort).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Moved 2 executions"));
		expect(h.input("x")).toBeUndefined();
	});

	it("uses the configured action and passes the key through when nothing can detach", () => {
		const h = harness(new KeybindingsManager({ "app.backgroundTasks.detach": "ctrl+y" }));
		h.emit("session_start");
		h.ctx.background.detachForeground.mockReturnValue(0);
		expect(h.input("\x02")).toBeUndefined();
		expect(h.input("\x19")).toBeUndefined();
		expect(h.ctx.background.detachForeground).toHaveBeenCalledOnce();
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("rebinds on session start without accumulating listeners and stops on shutdown", () => {
		const h = harness();
		h.emit("session_start");
		h.emit("session_start");
		expect(h.listeners.size).toBe(1);
		h.emit("session_shutdown");
		expect(h.listeners.size).toBe(0);
	});

	it("closes Background synchronously before awaiting terminal drain on normal shutdown", () => {
		const calls: string[] = [];
		const context = {
			isShuttingDown: false,
			session: { background: { close: () => calls.push("close") } },
			themeController: { disableAutoSync: () => calls.push("theme") },
			ui: {
				terminal: {
					drainInput: () => {
						calls.push("drain");
						return new Promise<void>(() => {});
					},
				},
			},
		};
		const prototype = InteractiveMode.prototype as unknown as { shutdown(this: typeof context): Promise<void> };
		void prototype.shutdown.call(context);
		expect(calls).toEqual(["close", "theme", "drain"]);
		expect(context.isShuttingDown).toBe(true);
	});

	it("reserves Ctrl+B locally without removing explicit editor overrides", () => {
		const kb = new KeybindingsManager();
		expect(kb.getKeys("app.backgroundTasks.detach")).toEqual(["ctrl+b"]);
		expect(kb.getKeys("tui.editor.cursorLeft")).toEqual(["left"]);
		kb.setUserBindings({ "app.backgroundTasks.detach": [], "tui.editor.cursorLeft": ["left", "ctrl+b"] });
		expect(kb.matches("\x02", "app.backgroundTasks.detach")).toBe(false);
		expect(kb.matches("\x02", "tui.editor.cursorLeft")).toBe(true);
	});
});
