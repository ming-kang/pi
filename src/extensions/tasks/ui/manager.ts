/** Panel lifecycle and input routing; selection, output ownership and layout have separate owners. */
import "../keybindings.ts";
import {
	type Component,
	type Focusable,
	Input,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { isTaskTerminal, type TasksContext } from "../../../core/tasks/types.ts";
import { STATUS_SPINNER_INTERVAL_MS } from "../../../modes/interactive/components/status-marker.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { TaskInspector } from "./inspector.ts";
import { renderTasksLayout, type TasksLayout } from "./layout.ts";
import { TaskList } from "./list.ts";
import { isStoppable, type PanelFocus, type PanelMode, TaskSelection, type TasksPanelState } from "./model.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";

export type TasksManagerHost = Pick<
	TasksContext,
	"list" | "read" | "kill" | "subscribe" | "retain" | "canDetach" | "detach"
>;
export interface TasksMenuOptions {
	tui: { requestRender(): void; terminal: { rows: number; columns: number } };
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	host: TasksManagerHost;
	state?: TasksPanelState;
	onClose(): void;
	pollIntervalMs?: number;
}

const BROWSE: PanelMode = { kind: "browse" };
const actions: AppKeybinding[] = [
	"app.tasks.search",
	"app.tasks.kill",
	"app.tasks.detachSelected",
	"app.tasks.previousTab",
	"app.tasks.nextTab",
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
	private readonly list = new TaskList();
	private readonly search: Input;
	private readonly unsubscribe: () => void;
	private readonly pollTimer: ReturnType<typeof setInterval>;
	private animationTimer?: ReturnType<typeof setInterval>;
	private mode: PanelMode = BROWSE;
	private feedback?: string;
	private focus: PanelFocus = "list";
	private dirty = true;
	private tickQueued = false;
	private refreshQueued = false;
	private disposed = false;
	private width: number;
	private layout?: TasksLayout;
	constructor(options: TasksMenuOptions) {
		this.options = options;
		this.width = options.tui.terminal.columns;
		this.selection = new TaskSelection(options.state ?? { tab: "output" });
		this.inspector = new TaskInspector({
			host: options.host,
			theme: options.theme,
			requestRender: () => options.tui.requestRender(),
		});
		this.search = new Input({ prompt: "Find task: ", placeholder: "title, command, kind or ID" });
		this.sync();
		this.selection.selectStartedSinceClose();
		this.inspector.select(this.selection.selected);
		this.list.showSelection();
		this.unsubscribe = options.host.subscribe(() => {
			this.dirty = true;
			this.queueTick();
			options.tui.requestRender();
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
		if (this.mode.kind === "confirmStop" && (this.mode.taskId !== selected?.id || isTaskTerminal(selected.status)))
			this.setMode(BROWSE);
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
	/** The one place the mode changes; the search input is focused exactly while searching. */
	private setMode(next: PanelMode): void {
		this.mode = next;
		this.search.focused = next.kind === "search";
	}
	/** Unwinds exactly one transient layer; from plain browsing it closes the panel. */
	private cancel(): void {
		switch (this.mode.kind) {
			case "search":
				this.finishSearch(true);
				break;
			case "help":
			case "confirmStop":
				this.setMode(BROWSE);
				break;
			case "browse":
				this.close();
				break;
		}
	}
	private close(): void {
		this.dispose();
		this.options.onClose();
	}
	private selectedChanged(): void {
		if (this.mode.kind === "confirmStop") this.setMode(BROWSE);
		this.list.showSelection();
		this.inspector.select(this.selection.selected);
		this.queueTick(true);
	}
	private requestStop(): void {
		const task = this.selection.selected;
		if (task && isStoppable(task)) this.setMode({ kind: "confirmStop", taskId: task.id });
	}
	private confirmStop(): void {
		const mode = this.mode;
		if (mode.kind !== "confirmStop") return;
		this.setMode(BROWSE);
		const task = this.selection.selected;
		if (mode.taskId !== task?.id || isTaskTerminal(task.status)) return;
		this.feedback = this.options.host.kill(mode.taskId)
			? "Cancellation requested; waiting for cleanup."
			: "No new cancellation requested.";
	}
	private startSearch(): void {
		this.setMode({ kind: "search", restore: { id: this.selection.state.selectedId, focus: this.focus } });
		this.focus = "list";
		this.search.setValue("");
	}
	private finishSearch(cancel: boolean): void {
		const mode = this.mode;
		if (mode.kind !== "search") return;
		const id = cancel ? mode.restore.id : this.selection.state.selectedId;
		if (!cancel && !id) return;
		this.focus = cancel ? mode.restore.focus : "list";
		this.setMode(BROWSE);
		this.selection.query = "";
		this.selection.select(id);
		this.selectedChanged();
	}
	private action(key: AppKeybinding): void {
		switch (key) {
			case "app.tasks.search":
				this.startSearch();
				break;
			case "app.tasks.previousTab":
			case "app.tasks.nextTab":
				if (this.focus === "inspector")
					this.selection.state.tab = key === "app.tasks.previousTab" ? "output" : "info";
				break;
			case "app.tasks.nextFocus":
			case "app.tasks.previousFocus":
				this.focus = this.focus === "list" ? "inspector" : "list";
				break;
			case "app.tasks.follow":
				if (this.focus === "inspector" && this.selection.state.tab === "output") {
					this.inspector.position.output.jump(true, true);
					this.queueTick(true);
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
						this.selection.state.tab === "output",
					);
				break;
			case "app.tasks.kill":
				this.requestStop();
				break;
			case "app.tasks.confirmStop":
				this.confirmStop();
				break;
			case "app.tasks.detachSelected": {
				const task = this.selection.selected;
				// The core decides; a full background lane throws its own explanation, shown as feedback.
				if (task?.mode === "foreground" && isStoppable(task)) {
					this.feedback = this.options.host.detach(task.id)
						? "Selected task moved to background; execution continues."
						: "This task cannot move to background.";
				}
				break;
			}
			case "app.tasks.help":
				this.setMode({ kind: "help", viewport: new TaskViewport() });
				break;
		}
	}
	private move(direction: number, page = false): void {
		if (this.mode.kind === "help") {
			this.mode.viewport.move(direction, page, false);
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
			this.inspector.position[this.selection.state.tab].move(direction, page, this.selection.state.tab === "output");
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		this.sync();
		this.render(this.width);
		this.feedback = undefined;
		try {
			if (this.layout?.tooSmall) {
				// The resize notice owns the screen; keys must not act on the hidden panel.
				if (this.options.keybindings.matches(data, "tui.select.cancel")) this.cancel();
			} else {
				switch (this.mode.kind) {
					case "help":
						this.helpInput(this.mode.viewport, data);
						break;
					case "search":
						this.searchInput(data);
						break;
					case "confirmStop":
						this.confirmInput(data);
						break;
					case "browse":
						this.browseInput(data);
						break;
				}
			}
		} catch (error) {
			this.feedback = cleanTaskText(error instanceof Error ? error.message : String(error));
		}
		if (this.disposed) return;
		this.queueTick(true);
		this.options.tui.requestRender();
	}
	private helpInput(viewport: TaskViewport, data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.tasks.help")) this.setMode(BROWSE);
		else if (kb.matches(data, "app.tasks.top") || kb.matches(data, "app.tasks.bottom"))
			viewport.jump(kb.matches(data, "app.tasks.bottom"), false);
		else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.editor.pageUp"))
			viewport.move(-1, kb.matches(data, "tui.editor.pageUp"), false);
		else if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.editor.pageDown"))
			viewport.move(1, kb.matches(data, "tui.editor.pageDown"), false);
	}
	private searchInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) this.cancel();
		else if (kb.matches(data, "tui.select.confirm")) this.finishSearch(false);
		else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.pageUp"))
			this.move(-1, kb.matches(data, "tui.select.pageUp"));
		else if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.pageDown"))
			this.move(1, kb.matches(data, "tui.select.pageDown"));
		else {
			this.search.handleInput(data);
			this.selection.query = this.search.getValue().slice(0, 512);
			this.selection.refresh();
			this.selectedChanged();
		}
	}
	private confirmInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "app.tasks.confirmStop")) this.confirmStop();
		else if (kb.matches(data, "tui.select.cancel")) this.cancel();
	}
	private browseInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		const pageUp = kb.matches(data, this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp");
		const pageDown = kb.matches(data, this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown");
		if (pageUp || kb.matches(data, "tui.select.up")) this.move(-1, pageUp);
		else if (pageDown || kb.matches(data, "tui.select.down")) this.move(1, pageDown);
		else if (kb.matches(data, "tui.select.confirm")) {
			if (this.focus === "list" && this.selection.selected) this.focus = "inspector";
		} else {
			const key = actions.find((key) => kb.matches(data, key));
			if (key) this.action(key);
		}
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.ctrl || event.alt || event.shift) return;
		// Feedback is transient: a click retracts it and acts, exactly like a keypress does.
		this.feedback = undefined;
		this.render(event.width);
		const layout = this.layout!;
		const mode = this.mode;
		if (event.type === "wheel" && event.wheelDelta) {
			if (
				mode.kind !== "confirmStop" &&
				!layout.tooSmall &&
				event.y >= 2 &&
				event.y < this.options.tui.terminal.rows - 3
			) {
				const delta = Math.sign(event.wheelDelta) * Math.min(20, Math.abs(event.wheelDelta));
				const region = this.width >= 100 ? (event.x < layout.listWidth ? "list" : "inspector") : this.focus;
				if (mode.kind === "help") mode.viewport.move(delta, false, false);
				else if (region === "list") this.list.scroll(delta);
				else if (mode.kind !== "search")
					this.inspector.position[this.selection.state.tab].move(
						delta,
						false,
						this.selection.state.tab === "output",
					);
			}
		} else if (event.type === "click" && event.button === "left") {
			const hit = layout.hits.find((hit) => hit.y === event.y && event.x >= hit.x && event.x < hit.x + hit.width);
			try {
				if (hit?.cancel) this.cancel();
				else if (hit?.taskId) {
					this.selection.select(hit.taskId);
					this.selectedChanged();
					this.focus = "list";
					if (mode.kind === "search") this.finishSearch(false);
				} else if (hit?.tab) {
					this.focus = "inspector";
					this.selection.state.tab = hit.tab;
				} else if (hit?.key) {
					if (hit.key === "app.tasks.follow") this.focus = "inspector";
					this.action(hit.key);
				} else if (
					mode.kind === "browse" &&
					!layout.tooSmall &&
					event.y >= 1 &&
					event.y < this.options.tui.terminal.rows - 2 &&
					this.width >= 100
				)
					this.focus = event.x < layout.listWidth ? "list" : "inspector";
			} catch (error) {
				this.feedback = cleanTaskText(error instanceof Error ? error.message : String(error));
			}
		} else return;
		this.queueTick(true);
		this.options.tui.requestRender();
		return { handled: true, focus: event.type === "click" };
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
			list: this.list,
			focus: this.focus,
			mode: this.mode,
			searchLine: (width) => this.search.render(width).join(""),
			feedback: this.feedback,
			canDetach: (id) => this.canDetach(id),
		});
		return this.layout.lines;
	}
	/** The panel's selection can lag the runtime by a notification; a task that is gone cannot move. */
	private canDetach(id: string): boolean {
		try {
			return this.options.host.canDetach(id);
		} catch {
			return false;
		}
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.selection.state.closedAt = Date.now();
		clearInterval(this.pollTimer);
		clearInterval(this.animationTimer);
		this.unsubscribe();
		this.inspector.dispose();
	}
}
