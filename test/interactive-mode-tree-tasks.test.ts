import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionBeforeTreeEvent } from "../src/core/extensions/types.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import tasksExtension from "../src/extensions/tasks/index.ts";

function running(command: string): TaskSnapshot {
	return {
		id: `bash-${command.length}`,
		kind: "bash",
		label: "Bash",
		title: command,
		output: "log",
		toolCallId: "call",
		anchorId: "elsewhere",
		mode: "background",
		status: "running",
		startedAt: 0,
	};
}

function treeUI(stopped: TaskSnapshot[], confirm: boolean, hasUI = true) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
	tasksExtension(pi);
	const ctx = {
		hasUI,
		tasks: { session: { stoppedByTreeNavigation: vi.fn(() => stopped) } },
		ui: { confirm: vi.fn(async () => confirm) },
	} as unknown as ExtensionContext;
	const navigate = () =>
		handlers.get("session_before_tree")?.({ preparation: { targetId: "target" } } as SessionBeforeTreeEvent, ctx);
	return { ctx, navigate };
}

describe("Tasks tree-navigation confirmation", () => {
	it("navigates without asking when no task would stop", async () => {
		const h = treeUI([], false);
		expect(await h.navigate()).toBeUndefined();
		expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("lists the tasks it would stop and cancels when declined", async () => {
		const h = treeUI([running("npm run build"), running("npm run dev\n--watch")], false);
		expect(await h.navigate()).toEqual({ cancel: true });
		const [title, message] = (h.ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(title).toBe("Stop 2 running tasks?");
		expect(message).toContain("npm run build");
		expect(message).toContain("npm run dev");
		expect(message).not.toContain("--watch");
	});

	it("navigates after the stop is confirmed", async () => {
		const h = treeUI([running("npm run build")], true);
		expect(await h.navigate()).toBeUndefined();
		expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
	});

	it("does not invent a confirmation prompt in a headless host", async () => {
		const h = treeUI([running("npm run build")], false, false);
		expect(await h.navigate()).toBeUndefined();
		expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
	});
});
