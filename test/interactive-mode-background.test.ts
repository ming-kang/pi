import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Listener = (data: string) => { consume?: boolean } | undefined;
function harness(bindings = new KeybindingsManager()) {
	const listeners = new Set<Listener>();
	const remove = vi.fn();
	const ctx = {
		ui: {
			addInputListener: (fn: Listener) => {
				listeners.add(fn);
				return () => {
					remove();
					listeners.delete(fn);
				};
			},
		},
		keybindings: bindings,
		session: { background: { detachForeground: vi.fn(() => 2) }, abort: vi.fn() },
		showStatus: vi.fn(),
		isShuttingDown: false,
		backgroundInputUnsubscribe: undefined as (() => void) | undefined,
	};
	const prototype = InteractiveMode.prototype as unknown as { setupBackgroundInputListener(this: typeof ctx): void };
	const setup = () => prototype.setupBackgroundInputListener.call(ctx);
	return { ctx, remove, setup, input: (data: string) => [...listeners][0]?.(data), listeners };
}
describe("interactive Background detach input listener", () => {
	it("routes independently of focused editor/dialog and never aborts the parent", () => {
		const h = harness();
		h.setup();
		expect(h.input("\x02")).toEqual({ consume: true });
		expect(h.ctx.session.background.detachForeground).toHaveBeenCalledOnce();
		expect(h.ctx.session.abort).not.toHaveBeenCalled();
		expect(h.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Moved 2 executions"));
		expect(h.input("x")).toBeUndefined();
	});
	it("uses the configured action, with exact no-eligible feedback", () => {
		const h = harness(new KeybindingsManager({ "app.backgroundTasks.detach": "ctrl+y" }));
		h.setup();
		h.ctx.session.background.detachForeground.mockReturnValue(0);
		expect(h.input("\x02")).toBeUndefined();
		expect(h.input("\x19")).toEqual({ consume: true });
		expect(h.ctx.showStatus).toHaveBeenCalledWith(
			"No foreground Bash or Subagent execution can be moved to the background.",
		);
	});
	it("rebinds without accumulating listeners, disposes and ignores shutdown input", () => {
		const h = harness();
		h.setup();
		h.setup();
		expect(h.listeners.size).toBe(1);
		expect(h.remove).toHaveBeenCalledOnce();
		h.ctx.isShuttingDown = true;
		h.input("\x02");
		expect(h.ctx.session.background.detachForeground).not.toHaveBeenCalled();
		h.ctx.backgroundInputUnsubscribe?.();
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
