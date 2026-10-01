/** Panel lifecycle and input routing; selection, output ownership and layout have separate owners. */
import {
	type Component,
	type Focusable,
	Input,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { isTaskTerminal, type TasksContext } from "../../../core/tasks/types.ts";
import type { TaskViewRegistry } from "../../../core/tasks/view.ts";
import { STATUS_SPINNER_INTERVAL_MS } from "../components/status-marker.ts";
import type { Theme } from "../theme/theme.ts";
import { TaskInspector } from "./inspector.ts";
import { renderTasksLayout, type TasksLayout } from "./layout.ts";
import { TaskSelection, type TasksPanelState } from "./model.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";

export type TasksManagerHost = Pick<TasksContext, "list" | "read" | "kill" | "subscribe" | "retain"> &
	Partial<Pick<TasksContext, "detach" | "enabled">>;
export interface TasksMenuOptions {
	tui: { requestRender(): void; terminal: { rows: number; columns: number } };
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	host: TasksManagerHost;
	views?: Pick<TaskViewRegistry, "get" | "subscribe">;
	state?: TasksPanelState;
	onClose(): void;
	pollIntervalMs?: number;
}

const actions: AppKeybinding[] = [
	"app.tasks.overview",
	"app.tasks.active",
	"app.tasks.history",
	"app.tasks.search",
	"app.tasks.kill",
	"app.tasks.detachSelected",
	"app.tasks.focusList",
	"app.tasks.focusInfo",
	"app.tasks.focusPreview",
	"app.tasks.follow",
	"app.tasks.top",
	"app.tasks.bottom",
	"app.tasks.nextFocus",
	"app.tasks.previousFocus",
	"app.tasks.help",
];

export class TasksMenu implements Component, Focusable {
	focused = false;
	private readonly options: TasksMenuOptions;
	private readonly selection: TaskSelection;
	private readonly inspector: TaskInspector;
	private readonly search: Input;
	private readonly unsubscribe: () => void;
	private readonly unsubscribeViews?: () => void;
	private readonly pollTimer: ReturnType<typeof setInterval>;
	private animationTimer?: ReturnType<typeof setInterval>;
	private killTimer?: ReturnType<typeof setTimeout>;
	private pendingKill?: string;
	private feedback?: string;
	private focus: "list" | "inspector" = "list";
	private searching = false;
	private help?: TaskViewport;
	private dirty = true;
	private tickQueued = false;
	private refreshQueued = false;
	private disposed = false;
	private width: number;
	private layout?: TasksLayout;
	constructor(options: TasksMenuOptions) {
		this.options = options;
		this.width = options.tui.terminal.columns;
		this.selection = new TaskSelection(options.state ?? { filter: "overview", tab: "output", query: "" });
		this.inspector = new TaskInspector({
			host: options.host,
			views: options.views,
			theme: options.theme,
			requestRender: () => options.tui.requestRender(),
		});
		this.search = new Input({ prompt: "Find task: ", placeholder: "title, command, kind or ID" });
		this.search.setValue(this.selection.state.query);
		this.sync();
		this.unsubscribe = options.host.subscribe(() => {
			this.dirty = true;
			this.queueTick();
			options.tui.requestRender();
		});
		this.unsubscribeViews = options.views?.subscribe(() => {
			this.inspector.select(this.selection.selected);
			this.queueTick(true);
		});
		this.pollTimer = setInterval(() => {
			this.queueTick(true);
			if (this.selection.activeCount) options.tui.requestRender();
		}, options.pollIntervalMs ?? 1000);
		this.pollTimer.unref?.();
		this.queueTick(true);
	}
	private sync(): void {
		if (this.disposed || !this.dirty) return;
		this.dirty = false;
		const previous = this.selection.selected;
		this.selection.sync(this.options.host.list());
		this.inspector.select(this.selection.selected);
		this.inspector.prune(new Set(this.selection.all.map((task) => task.id)));
		const selected = this.selection.selected;
		if (selected && isTaskTerminal(selected.status) && previous && !isTaskTerminal(previous.status))
			this.feedback = undefined;
		if (this.pendingKill && (this.pendingKill !== selected?.id || (selected && isTaskTerminal(selected.status))))
			this.clearKill();
		const animates = this.selection.all.some((task) => task.status === "running");
		if (animates && !this.animationTimer) {
			this.animationTimer = setInterval(() => this.options.tui.requestRender(), STATUS_SPINNER_INTERVAL_MS);
			this.animationTimer.unref?.();
		} else if (!animates) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}
	private queueTick(refresh = false): void {
		if (this.disposed) return;
		this.refreshQueued ||= refresh;
		if (this.tickQueued) return;
		this.tickQueued = true;
		void Promise.resolve()
			.then(async () => {
				this.tickQueued = false;
				if (this.disposed) return;
				const refresh = this.refreshQueued;
				this.refreshQueued = false;
				this.sync();
				if (refresh || (this.inspector.task && isTaskTerminal(this.inspector.task.status)))
					await this.inspector.refresh();
			})
			.catch(() => {
				/* Task observers cannot reject execution. */
			});
	}
	invalidate(): void {
		this.inspector.invalidate();
	}
	private clearKill(): void {
		clearTimeout(this.killTimer);
		this.killTimer = undefined;
		this.pendingKill = undefined;
	}
	private selectedChanged(): void {
		this.clearKill();
		this.inspector.select(this.selection.selected);
		this.queueTick(true);
	}
	private stop(confirm = false): void {
		const task = this.selection.selected;
		if (confirm) {
			const id = this.pendingKill;
			this.clearKill();
			if (!id || id !== task?.id || isTaskTerminal(task.status)) return;
			this.feedback = this.options.host.kill(id)
				? "Cancellation requested; waiting for cleanup."
				: "No new cancellation requested.";
		} else if (task && !isTaskTerminal(task.status) && task.status !== "stopping") {
			this.pendingKill = task.id;
			this.killTimer = setTimeout(() => {
				this.clearKill();
				this.feedback = "Stop confirmation expired.";
				this.options.tui.requestRender();
			}, 5000);
			this.killTimer.unref?.();
		}
	}
	private action(key: AppKeybinding): void {
		switch (key) {
			case "app.tasks.overview":
			case "app.tasks.active":
			case "app.tasks.history":
				this.selection.filter(
					key === "app.tasks.overview" ? "overview" : key === "app.tasks.active" ? "active" : "history",
				);
				this.focus = "list";
				this.selectedChanged();
				break;
			case "app.tasks.search":
				this.searching = true;
				this.search.focused = true;
				this.search.setValue(this.selection.state.query);
				break;
			case "app.tasks.focusList":
				this.focus = "list";
				break;
			case "app.tasks.focusInfo":
				this.focus = "inspector";
				this.selection.state.tab = "info";
				break;
			case "app.tasks.focusPreview":
				this.focus = "inspector";
				this.selection.state.tab = "output";
				break;
			case "app.tasks.nextFocus":
			case "app.tasks.previousFocus": {
				const current = this.focus === "list" ? 0 : this.selection.state.tab === "output" ? 1 : 2;
				const next = (current + (key === "app.tasks.nextFocus" ? 1 : 2)) % 3;
				this.focus = next === 0 ? "list" : "inspector";
				if (next) this.selection.state.tab = next === 1 ? "output" : "info";
				break;
			}
			case "app.tasks.follow":
				if (this.inspector.tail) {
					this.inspector.position.output.jump(true, true);
					this.focus = "inspector";
					this.selection.state.tab = "output";
					this.queueTick();
				}
				break;
			case "app.tasks.top":
			case "app.tasks.bottom":
				if (this.focus === "list") {
					this.selection.select(
						key === "app.tasks.top" ? this.selection.rows[0]?.id : this.selection.rows.at(-1)?.id,
					);
					this.selectedChanged();
				} else
					this.inspector.position[this.selection.state.tab].jump(
						key === "app.tasks.bottom",
						this.selection.state.tab === "output" && this.inspector.tail,
					);
				break;
			case "app.tasks.kill":
				this.stop();
				break;
			case "app.tasks.confirmStop":
				this.stop(true);
				break;
			case "app.tasks.detachSelected": {
				const task = this.selection.selected;
				if (
					task?.mode === "foreground" &&
					!isTaskTerminal(task.status) &&
					task.status !== "stopping" &&
					this.options.host.enabled !== false
				) {
					this.feedback = this.options.host.detach?.(task.id)
						? "Selected task moved to background; execution continues."
						: "This task cannot move to background.";
				}
				break;
			}
			case "app.tasks.help":
				this.help = this.help ? undefined : new TaskViewport();
				break;
		}
	}
	private move(direction: number, page = false): void {
		if (this.help) {
			this.help.move(direction, page, false);
			return;
		}
		if (this.focus === "list") {
			const rows = this.selection.rows;
			if (!rows.length) return;
			const index = rows.findIndex((task) => task.id === this.selection.state.selectedId);
			const next = page
				? Math.max(0, Math.min(rows.length - 1, index + direction * (this.layout?.listPageSize ?? 1)))
				: (index + direction + rows.length) % rows.length;
			this.selection.select(rows[next]?.id);
			this.selectedChanged();
		} else
			this.inspector.position[this.selection.state.tab].move(
				direction,
				page,
				this.selection.state.tab === "output" && this.inspector.tail,
			);
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		this.sync();
		this.render(this.width);
		const kb = this.options.keybindings;
		this.feedback = undefined;
		try {
			if (this.searching) {
				if (kb.matches(data, "tui.select.cancel")) {
					this.selection.state.query = "";
					this.search.setValue("");
					this.searching = false;
				} else if (kb.matches(data, "tui.select.confirm")) this.searching = false;
				else {
					this.search.handleInput(data);
					this.selection.state.query = this.search.getValue().slice(0, 512);
				}
				this.search.focused = this.searching;
				this.selection.refresh();
				this.selectedChanged();
			} else if (this.pendingKill) {
				if (kb.matches(data, "app.tasks.confirmStop")) this.stop(true);
				else this.clearKill();
			} else if (kb.matches(data, "tui.select.cancel")) {
				if (this.help) this.help = undefined;
				else if (this.width < 60 || this.options.tui.terminal.rows < 14 || this.focus === "list") {
					this.dispose();
					this.options.onClose();
					return;
				} else this.focus = "list";
			} else {
				const pageUp = kb.matches(data, this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp");
				const pageDown = kb.matches(data, this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown");
				if (pageUp || kb.matches(data, "tui.select.up")) this.move(-1, pageUp);
				else if (pageDown || kb.matches(data, "tui.select.down")) this.move(1, pageDown);
				else if (kb.matches(data, "tui.select.confirm")) this.action("app.tasks.focusPreview");
				else {
					const key = actions.find((key) => kb.matches(data, key));
					if (key) this.action(key);
					else if (this.focus === "inspector" && !this.help)
						this.inspector.handleInput(this.selection.state.tab, data);
				}
			}
		} catch (error) {
			this.feedback = cleanTaskText(String(error));
		}
		this.queueTick(true);
		this.options.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.ctrl || event.alt || event.shift) return;
		this.render(event.width);
		const layout = this.layout!;
		if (event.type === "wheel" && event.wheelDelta) {
			if (!this.pendingKill && !this.searching) {
				if (this.width >= 100) this.focus = event.x < layout.listWidth ? "list" : "inspector";
				for (let i = 0; i < Math.min(20, Math.abs(event.wheelDelta)); i++) this.move(Math.sign(event.wheelDelta));
			}
		} else if (event.type === "click" && event.button === "left") {
			const hit = layout.hits.find((hit) => hit.y === event.y && event.x >= hit.x && event.x < hit.x + hit.width);
			try {
				if (hit?.taskId) {
					this.selection.select(hit.taskId);
					this.selectedChanged();
					this.focus = this.width < 100 ? "inspector" : "list";
				} else if (hit?.key) this.action(hit.key);
				else if (
					!this.pendingKill &&
					!this.searching &&
					event.y >= layout.contentY &&
					(this.width < 100 || event.x > layout.listWidth)
				)
					this.focus = "inspector";
			} catch (error) {
				this.feedback = cleanTaskText(String(error));
			}
		} else return;
		this.queueTick(true);
		this.options.tui.requestRender();
		return { handled: true, focus: true };
	}
	render(width: number): string[] {
		this.width = width;
		this.sync();
		this.layout = renderTasksLayout({
			width,
			height: this.options.tui.terminal.rows,
			theme: this.options.theme,
			keybindings: this.options.keybindings,
			selection: this.selection,
			inspector: this.inspector,
			focus: this.focus,
			searchLine: this.searching ? this.search.render(width).join("") : undefined,
			pendingKill: this.pendingKill,
			feedback: this.feedback,
			help: this.help,
			canDetach: this.options.host.enabled !== false && !!this.options.host.detach,
		});
		return this.layout.lines;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.pollTimer);
		clearInterval(this.animationTimer);
		this.clearKill();
		this.unsubscribe();
		this.unsubscribeViews?.();
		this.inspector.dispose();
	}
}
