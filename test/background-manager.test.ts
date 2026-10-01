import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";
import { TasksMenu } from "../src/modes/interactive/tasks/manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const runtimes: TaskRuntime[] = [];
const menus: TasksMenu[] = [];
afterEach(async () => {
	for (const menu of menus.splice(0)) menu.dispose();
	for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});
function start(runtime: TaskRuntime, kind = "bash") {
	let control!: TaskControl<undefined>;
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const outcome = runtime.execute({
		kind,
		title: "Build",
		command: "npm run build",
		toolCallId: "call",
		run: async (next) => {
			control = next;
			next.accept();
			next.publish({ content: [{ type: "text", text: "building" }], details: undefined });
			await done;
			return { result: { content: [{ type: "text", text: "Build succeeded" }], details: undefined }, exitCode: 0 };
		},
	});
	return { control, finish, outcome };
}
function panel(runtime: TaskRuntime) {
	initTheme("dark");
	const menu = new TasksMenu({
		host: runtime,
		theme,
		keybindings: new KeybindingsManager(),
		tui: { requestRender: vi.fn(), terminal: { rows: 30, columns: 140 } },
		onClose: vi.fn(),
		pollIntervalMs: 20,
	});
	menus.push(menu);
	return { menu, frame: () => menu.render(140).map(stripTerminalSequences).join("\n") };
}
describe("Tasks panel runtime integration", () => {
	it("keeps a watched final result through eviction pressure without delaying delivery", async () => {
		const runtime = new TaskRuntime({ enabled: true, maxHistory: 0 });
		runtimes.push(runtime);
		const execution = start(runtime);
		const h = panel(runtime);
		await vi.waitFor(() => expect(h.frame()).toContain("building"));
		runtime.detach(execution.control.id);
		await execution.outcome;
		execution.finish();
		await runtime.wait(execution.control.id);
		await vi.waitFor(() => expect(h.frame()).toContain("Build succeeded"));
		expect(h.frame()).toContain("Finished");
		expect(runtime.pendingNotifications()).toMatchObject([{ id: execution.control.id }]);
		runtime.markDelivered(execution.control.id);
		expect(runtime.get(execution.control.id).status).toBe("completed");
		h.menu.dispose();
		expect(runtime.list()).toEqual([]);
	});
	it("reads a missing log's saved fallback and keeps its diagnostic accessible", async () => {
		const runtime = new TaskRuntime();
		runtimes.push(runtime);
		const execution = start(runtime);
		execution.control.setOutputPath("nonexistent-task-output.log");
		const h = panel(runtime);
		await vi.waitFor(() => expect(h.frame()).toContain("Output could not be read"));
		expect(h.frame()).toContain("building");
		execution.finish();
		await execution.outcome;
		await vi.waitFor(() => expect(h.frame()).toContain("Build succeeded"));
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("Exit      0");
	});
	it("drops an out-of-branch selection without showing another branch's result", async () => {
		const runtime = new TaskRuntime({ anchor: () => "old-branch" });
		runtimes.push(runtime);
		const execution = start(runtime);
		const h = panel(runtime);
		execution.finish();
		await execution.outcome;
		await vi.waitFor(() => expect(h.frame()).toContain("Build succeeded"));
		await runtime.cancelOutsideBranch(new Set());
		expect(h.frame()).not.toContain("Build succeeded");
		expect(h.frame()).toContain("No retained tasks.");
	});
});
