/** Shared fixtures for the /tasks panel tests: a task factory, a fake host and a menu builder. */
import { stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { TaskSnapshot } from "../../src/core/tasks/types.ts";
import { TasksMenu } from "../../src/extensions/tasks/ui/manager.ts";
import type { TasksPanelState } from "../../src/extensions/tasks/ui/model.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";

const menus: TasksMenu[] = [];
/** Disposes every menu a harness built; call from afterEach. */
export function disposeMenus(): void {
	for (const menu of menus.splice(0)) menu.dispose();
}
export function task(id: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id,
		kind: "bash",
		label: "Bash",
		title: `echo ${id}`,
		output: "log",
		input: { label: "Command", text: `echo ${id}`, truncated: false },
		// Managed shell tasks always stream to a log; the fake host's read serves it.
		outputPath: `/tmp/${id}.log`,
		mode: "foreground",
		status: "running",
		startedAt: 0,
		toolCallId: id,
		anchorId: null,
		...overrides,
	};
}
export function harness(
	tasks = [task("first"), task("second", { mode: "background" })],
	{
		width = 140,
		height = 30,
		state = { tab: "output" },
	}: { width?: number; height?: number; state?: TasksPanelState } = {},
) {
	let listener = () => {};
	let output = Array.from({ length: 80 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
	const release = vi.fn();
	const host = {
		list: vi.fn(() => structuredClone(tasks)),
		read: vi.fn(async (id: string) => ({
			task: structuredClone(tasks.find((t) => t.id === id)!),
			text: output,
			totalBytes: output.length,
			truncated: false,
		})),
		kill: vi.fn(() => true),
		canDetach: vi.fn((id: string) => {
			const t = tasks.find((candidate) => candidate.id === id);
			return t?.mode === "foreground" && t.status === "running";
		}),
		detach: vi.fn(() => true),
		retain: vi.fn(() => release),
		subscribe: (fn: () => void) => {
			listener = fn;
			return vi.fn();
		},
	};
	const tui = { requestRender: vi.fn(), terminal: { rows: height, columns: width } };
	const close = vi.fn();
	const keybindings = new KeybindingsManager();
	const menu = new TasksMenu({ host, tui, theme, keybindings, state, onClose: close });
	menus.push(menu);
	return {
		menu,
		state,
		tasks,
		host,
		tui,
		close,
		keybindings,
		release,
		change: () => listener(),
		setOutput: (text: string) => {
			output = text;
		},
		frame: () => menu.render(tui.terminal.columns).map(stripTerminalSequences).join("\n"),
		left: () =>
			menu
				.render(width)
				.map((line) => stripTerminalSequences(line).split("│")[1])
				.join("\n"),
		/** The screen row of the list row containing `text`. */
		listRow: (text: string) =>
			menu
				.render(tui.terminal.columns)
				.map(stripTerminalSequences)
				.findIndex((line) => (line.split("│")[1] ?? "").includes(text)),
	};
}
export function mouse(x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 120,
		height: 30,
		shift: false,
		ctrl: false,
		alt: false,
		...extra,
	};
}
export const backgroundTask = (id: string, overrides: Partial<TaskSnapshot> = {}) =>
	task(id, { mode: "background", ...overrides });
