import { getKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import { isTaskTerminal, type TasksContext } from "../../../core/tasks/types.ts";
import { TASKS_DETACH_HINT_DELAY_MS } from "../../../core/tools/tasks/constants.ts";
import { keyLabel } from "../components/keybinding-hints.ts";
import { theme } from "../theme/theme.ts";
import { TasksMenu } from "./manager.ts";
import type { TasksPanelState } from "./model.ts";

export interface TasksUI {
	open(): Promise<void>;
	dispose(): void;
}

/** Host-owned task UI; it is available without loading an extension. */
export function bindTasksUI(ctx: { tasks: TasksContext; ui: ExtensionUIContext }): TasksUI {
	const state: TasksPanelState = { tab: "output" };
	let unsubscribe: (() => void) | undefined;
	let unsubscribeDetachKey: (() => void) | undefined;
	let closeMenu: (() => void) | undefined;
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	const start = () => {
		unsubscribe?.();
		unsubscribeDetachKey?.();
		const update = () => {
			clearTimeout(hintTimer);
			hintTimer = undefined;
			const all = ctx.tasks.list();
			const background = all.filter((task) => task.mode === "background" && !isTaskTerminal(task.status)).length;
			const parts: string[] = [];
			if (background) {
				parts.push(theme.fg("text", `${background} background task${background === 1 ? "" : "s"}`));
				parts.push(theme.fg("accent", "/tasks") + theme.fg("muted", " to view"));
			}
			// Teach the detach key once something has run long enough to be worth moving, and
			// only while it can move, independently of the background task summary.
			const detachKey = keyLabel("app.tasks.detach");
			const now = Date.now();
			const movable = all.filter((task) => ctx.tasks.canDetach(task.id));
			const waits = movable
				.map((task) => task.startedAt + TASKS_DETACH_HINT_DELAY_MS - now)
				.filter((wait) => wait > 0);
			if (detachKey && movable.length > waits.length)
				parts.push(theme.fg("accent", detachKey) + theme.fg("muted", " to run in background"));
			if (detachKey && waits.length > 0) {
				// The service notifies on state changes, not on time, so wake up when the next
				// execution crosses the threshold.
				hintTimer = setTimeout(update, Math.min(...waits));
				hintTimer.unref?.();
			}
			ctx.ui.setStatus("background", parts.length ? parts.join(theme.fg("dim", " · ")) : undefined);
		};
		unsubscribe = ctx.tasks.subscribe(update);
		unsubscribeDetachKey = ctx.ui.onTerminalInput((data) => {
			if (!getKeybindings().matches(data, "app.tasks.detach")) return undefined;
			let count: number;
			try {
				count = ctx.tasks.detachForeground();
			} catch (error) {
				// Work could move, but every background slot is taken.
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return { consume: true };
			}
			// Nothing can move: let the key fall through to editor bindings instead of
			// spending it on a "nothing happened" status line.
			if (count === 0) return undefined;
			ctx.ui.notify(
				`Moved ${count} execution${count === 1 ? "" : "s"} to the background. Use /tasks to manage tasks.`,
			);
			return { consume: true };
		});
		update();
	};
	const dispose = () => {
		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeDetachKey?.();
		unsubscribeDetachKey = undefined;
		clearTimeout(hintTimer);
		hintTimer = undefined;
		closeMenu?.();
		closeMenu = undefined;
		ctx.ui.setStatus("background", undefined);
	};
	start();
	return {
		dispose,
		open: async () => {
			closeMenu?.();
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					const close = () => {
						if (closeMenu === close) closeMenu = undefined;
						done();
					};
					closeMenu = close;
					return new TasksMenu({
						state,
						tui,
						theme,
						keybindings,
						host: ctx.tasks,
						onClose: close,
					});
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
			);
		},
	};
}
