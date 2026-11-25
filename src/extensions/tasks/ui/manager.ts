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
import { isTaskTerminal, type TaskSnapshot, type TasksContext } from "../../../core/tasks/types.ts";
import { STATUS_SPINNER_INTERVAL_MS } from "../../../modes/interactive/components/status-marker.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import type { Feedback } from "./footer.ts";
import { TaskInspector } from "./inspector.ts";
import { isInspectorVisible, renderTasksLayout, type TasksLayout } from "./layout.ts";
import { TaskList } from "./list.ts";
import { type PanelFocus, type PanelMode, type TaskAction, TaskSelection, type TasksPanelState } from "./model.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";
import { applyOutputSearch, streamsLog } from "./views.ts";

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
	initialTaskId?: string;
	copyText?: (text: string) => Promise<void>;
	onClose(): void;
	pollIntervalMs?: number;
}

const BROWSE: PanelMode = { kind: "browse" };
/** Feedback outlives a glance but not the next thing the user does. */
const FEEDBACK_MS = 4000;
const QUERY_LIMIT = 512;
const actions: AppKeybinding[] = [
	"app.tasks.search",
	"app.tasks.filter",
	"app.tasks.findInOutput",
	"app.tasks.copy",
	"app.tasks.loadEarlier",
	"app.tasks.loadLater",
	"app.tasks.kill",
	"app.tasks.killAll",
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

/** Why a stop or background request cannot apply to this task, for the states the footer does not offer. */
function unavailableReason(task: TaskSnapshot): string | undefined {
	if (isTaskTerminal(task.status)) return "Task already finished.";
	if (task.status === "stopping") return "Task is already stopping.";
	return undefined;
}

export class TasksMenu implements Component, Focusable {
	focused = false;
	private readonly options: TasksMenuOptions;
	private readonly selection: TaskSelection;
	private readonly inspector: TaskInspector;
	private readonly list = new TaskList();
	private readonly unsubscribe: () => void;
	private pollTimer?: ReturnType<typeof setInterval>;
	private animationTimer?: ReturnType<typeof setInterval>;
	private feedbackTimer?: ReturnType<typeof setTimeout>;
	private mode: PanelMode = BROWSE;
	private feedback?: Feedback;
	private focus: PanelFocus = "list";
	private dirty = true;
	private layoutDirty = true;
	private layoutSize?: { width: number; height: number };
	private tickQueued = false;
	private refreshQueued = false;
	private forceRefreshQueued = false;
	private disposed = false;
	private width: number;
	private layout?: TasksLayout;
	private wasOutputVisible = false;
	private outputSearchMatches: number[] = [];
	constructor(options: TasksMenuOptions) {
		this.options = options;
		this.width = options.tui.terminal.columns;
		this.selection = new TaskSelection(options.state ?? { tab: "output" });
		this.inspector = new TaskInspector({
			host: options.host,
			theme: options.theme,
			isOutputVisible: () => this.isOutputVisible(),
			requestRender: () => {
				this.layoutDirty = true;
				options.tui.requestRender();
			},
		});
		this.sync();
		if (options.initialTaskId && this.selection.all.some((task) => task.id === options.initialTaskId)) {
			if (!this.selection.rows.some((task) => task.id === options.initialTaskId)) {
				this.selection.state.filter = undefined;
			}
			this.selection.select(options.initialTaskId);
		} else {
			this.selection.selectStartedSinceClose();
		}
		this.inspector.select(this.selection.selected);
		this.list.showSelection();
		this.unsubscribe = options.host.subscribe(() => {
			this.dirty = true;
			this.layoutDirty = true;
			this.queueTick();
			options.tui.requestRender();
		});
		this.queueTick(true);
	}
	/** The search text, owned by the search mode: browsing always sees every retained task. */
	private get query(): string {
		return this.mode.kind === "search" ? this.mode.input.getValue().slice(0, QUERY_LIMIT) : "";
	}
	private select(id: string | undefined): void {
		this.selection.select(id, this.query);
	}
	private sync(): void {
		if (this.disposed || !this.dirty) return;
		this.dirty = false;
		this.selection.sync(this.options.host.list(), this.query);
		this.inspector.select(this.selection.selected);
		this.inspector.prune(new Set(this.selection.all.map((task) => task.id)));
		const selected = this.selection.selected;
		if (this.mode.kind === "confirmStop" && (this.mode.taskId !== selected?.id || isTaskTerminal(selected.status)))
			this.setMode(BROWSE);
		if (this.mode.kind === "confirmStopAll") {
			const count = this.selection.stoppable().length;
			if (count === 0) this.setMode(BROWSE);
			else this.mode = { kind: "confirmStopAll", count };
		}
		if (this.selection.activeCount > 0 && !this.pollTimer) {
			this.pollTimer = setInterval(() => {
				this.queueTick(true);
				if (this.selection.activeCount) this.options.tui.requestRender();
			}, this.options.pollIntervalMs ?? 1000);
			this.pollTimer.unref?.();
		} else if (this.selection.activeCount === 0 && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		const animates = this.selection.all.some((task) => task.status === "running" || task.status === "stopping");
		if (animates && !this.animationTimer) {
			this.animationTimer = setInterval(() => this.options.tui.requestRender(), STATUS_SPINNER_INTERVAL_MS);
			this.animationTimer.unref?.();
		} else if (!animates) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}
	private queueTick(refresh = false, force = false): void {
		if (this.disposed) return;
		this.refreshQueued ||= refresh;
		this.forceRefreshQueued ||= force;
		if (this.tickQueued) return;
		this.tickQueued = true;
		void Promise.resolve()
			.then(async () => {
				this.tickQueued = false;
				if (this.disposed) return;
				const refresh = this.refreshQueued;
				const force = this.forceRefreshQueued;
				this.refreshQueued = false;
				this.forceRefreshQueued = false;
				this.sync();
				const outputVisible = this.isOutputVisible();
				const revealed = outputVisible && !this.wasOutputVisible;
				this.wasOutputVisible = outputVisible;
				if (revealed || refresh || force || (this.inspector.task && isTaskTerminal(this.inspector.task.status)))
					await this.inspector.refresh(force);
			})
			.catch(() => {
				/* Task observers cannot reject execution. */
			});
	}
	private isOutputVisible(): boolean {
		return (
			this.selection.state.tab === "output" &&
			isInspectorVisible({
				width: this.width,
				height: this.options.tui.terminal.rows,
				focus: this.focus,
				mode: this.mode,
			})
		);
	}
	invalidate(): void {
		this.inspector.invalidate();
	}
	private setMode(next: PanelMode): void {
		this.mode = next;
		this.layoutDirty = true;
	}
	/** Reports an action that did not do what was asked; it clears on the next input or after a few seconds. */
	private notify(tone: Feedback["tone"], text: string): void {
		this.clearFeedback();
		this.feedback = { tone, text };
		this.layoutDirty = true;
		this.feedbackTimer = setTimeout(() => {
			this.feedbackTimer = undefined;
			this.feedback = undefined;
			this.layoutDirty = true;
			if (!this.disposed) this.options.tui.requestRender();
		}, FEEDBACK_MS);
		this.feedbackTimer.unref?.();
	}
	private clearFeedback(): void {
		clearTimeout(this.feedbackTimer);
		this.feedbackTimer = undefined;
		if (this.feedback !== undefined) {
			this.feedback = undefined;
			this.layoutDirty = true;
		}
	}
	/**
	 * Unwinds exactly one layer: search, help or a confirmation; then the inspector back to the
	 * list when the list is hidden; from plain browsing it closes the panel.
	 */
	private escape(): void {
		switch (this.mode.kind) {
			case "search":
				this.finishSearch(true);
				break;
			case "searchOutput":
				this.focus = this.mode.restore.focus;
				this.outputSearchMatches = [];
				this.setMode(BROWSE);
				break;
			case "help":
			case "confirmStop":
			case "confirmStopAll":
				this.setMode(BROWSE);
				break;
			case "browse":
				if (this.layout && !this.layout.tooSmall && !this.layout.split && this.focus === "inspector") {
					this.focus = "list";
					this.layoutDirty = true;
				} else this.close();
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
		this.layoutDirty = true;
		this.queueTick(true);
	}
	private requestStop(): void {
		const task = this.selection.selected;
		if (!task) return;
		const reason = unavailableReason(task);
		if (reason) this.notify("warning", reason);
		else this.setMode({ kind: "confirmStop", taskId: task.id });
	}
	private requestStopAll(): void {
		const stoppable = this.selection.stoppable();
		if (stoppable.length === 0) {
			this.notify("warning", "No active tasks to stop.");
			return;
		}
		this.setMode({ kind: "confirmStopAll", count: stoppable.length });
	}
	private confirmStop(): void {
		const mode = this.mode;
		if (mode.kind === "confirmStopAll") {
			this.setMode(BROWSE);
			const stoppable = this.selection.stoppable();
			let stopped = 0;
			for (const task of stoppable) {
				if (this.options.host.kill(task.id)) stopped++;
			}
			if (stopped === 0) this.notify("warning", "No active tasks were stopped.");
			return;
		}
		if (mode.kind !== "confirmStop") return;
		this.setMode(BROWSE);
		const task = this.selection.selected;
		if (mode.taskId !== task?.id || isTaskTerminal(task.status)) return;
		// A granted request shows as Stopping on the row and header; only a refusal needs saying.
		if (!this.options.host.kill(mode.taskId)) this.notify("warning", "No new cancellation requested.");
	}
	private cycleFilter(): void {
		this.selection.cycleFilter(this.query);
		this.selectedChanged();
	}
	private copySelected(): void {
		const task = this.selection.selected;
		if (!task) return;
		let label: string;
		let text: string;
		if (this.focus === "list") {
			label = "task ID";
			text = task.id;
		} else if (this.selection.state.tab === "info") {
			label = task.input ? task.input.label.toLowerCase() : "title";
			text = task.input?.text ?? task.title;
		} else {
			label = "output";
			const read = this.inspector.position.read;
			const fromLog = streamsLog(task) && read !== undefined && !read.readError;
			text = (fromLog ? read.text : (task.display?.text ?? task.result?.text)) ?? "";
		}
		if (!text) {
			this.notify("warning", `Nothing to copy for ${label}.`);
			return;
		}
		const writer = this.options.copyText ?? copyToClipboard;
		void writer(text).then(
			() => {
				if (!this.disposed) {
					this.notify("info", `Copied ${label}.`);
					this.options.tui.requestRender();
				}
			},
			(error: unknown) => {
				if (!this.disposed) {
					this.notify("error", cleanTaskText(error instanceof Error ? error.message : String(error)));
					this.options.tui.requestRender();
				}
			},
		);
	}
	private startOutputSearch(): void {
		if (!this.selection.selected) return;
		const input = new Input({ prompt: "Find in view: ", placeholder: "text to highlight" });
		input.focused = true;
		this.outputSearchMatches = [];
		this.setMode({ kind: "searchOutput", restore: { focus: this.focus }, input, matchIndex: 0 });
		this.focus = "inspector";
	}
	private jumpToOutputMatch(): void {
		if (this.mode.kind !== "searchOutput" || !this.selection.selected) return;
		const query = this.mode.input.getValue().slice(0, QUERY_LIMIT);
		const innerWidth = Math.max(
			1,
			(this.layout?.split ? this.width - Math.min(60, Math.max(34, Math.round(this.width * 0.4))) - 1 : this.width) -
				2,
		);
		const tab = this.selection.state.tab;
		const rawLines = tab === "info" ? this.inspector.details(innerWidth) : this.inspector.output(innerWidth);
		const { matchLines, activeIndex } = applyOutputSearch(rawLines, query, this.mode.matchIndex, this.options.theme);
		this.outputSearchMatches = matchLines;
		if (activeIndex >= 0 && matchLines[activeIndex] !== undefined) {
			this.mode.matchIndex = activeIndex;
			// Lay out entries before jumping so scrollToLine sees current wrapped indices.
			const viewport = this.inspector.position[tab];
			viewport.layout(rawLines, innerWidth, Math.max(1, this.options.tui.terminal.rows - 6));
			viewport.scrollToLine(matchLines[activeIndex]!);
		}
	}
	private detachSelected(): void {
		const task = this.selection.selected;
		if (!task) return;
		const reason =
			unavailableReason(task) ?? (task.mode === "background" ? "Task is already in the background." : "");
		if (reason) {
			this.notify("warning", reason);
			return;
		}
		try {
			// The core decides; a full background lane throws its own explanation.
			if (!this.options.host.detach(task.id)) this.notify("warning", "This task cannot move to background.");
		} catch (error) {
			this.notify("warning", cleanTaskText(error instanceof Error ? error.message : String(error)));
		}
	}
	private startSearch(): void {
		const input = new Input({ prompt: "Find task: ", placeholder: "title, command, kind or ID" });
		input.focused = true;
		this.setMode({ kind: "search", restore: { id: this.selection.state.selectedId, focus: this.focus }, input });
		this.focus = "list";
	}
	private finishSearch(cancel: boolean): void {
		const mode = this.mode;
		if (mode.kind !== "search") return;
		const id = cancel ? mode.restore.id : this.selection.state.selectedId;
		if (!cancel && !id) return;
		this.focus = cancel ? mode.restore.focus : "list";
		this.setMode(BROWSE);
		this.select(id);
		this.selectedChanged();
	}
	private open(): void {
		if (this.focus === "list" && this.selection.selected) {
			this.focus = "inspector";
			this.layoutDirty = true;
			this.queueTick(true);
		}
	}
	private action(key: AppKeybinding): void {
		switch (key) {
			case "app.tasks.search":
				this.startSearch();
				break;
			case "app.tasks.filter":
				this.cycleFilter();
				break;
			case "app.tasks.findInOutput":
				this.startOutputSearch();
				break;
			case "app.tasks.copy":
				this.copySelected();
				break;
			case "app.tasks.loadEarlier":
				if (this.selection.state.tab === "output") {
					if (this.inspector.loadEarlier()) {
						this.layoutDirty = true;
						this.queueTick(true, true);
					} else {
						this.notify("warning", "Already at the beginning of this log.");
					}
				}
				break;
			case "app.tasks.loadLater":
				if (this.selection.state.tab === "output") {
					if (this.inspector.loadLater()) {
						this.layoutDirty = true;
						this.queueTick(true, true);
					} else {
						this.notify("warning", "Already at the latest output.");
					}
				}
				break;
			case "app.tasks.previousTab":
			case "app.tasks.nextTab":
				if (this.focus === "inspector") {
					this.selection.state.tab = key === "app.tasks.previousTab" ? "output" : "info";
					this.layoutDirty = true;
					if (this.selection.state.tab === "output") this.queueTick(true);
				}
				break;
			case "app.tasks.nextFocus":
			case "app.tasks.previousFocus":
				this.focus = this.focus === "list" ? "inspector" : "list";
				this.layoutDirty = true;
				if (this.focus === "inspector") this.queueTick(true);
				break;
			case "app.tasks.follow":
				if (this.focus === "inspector" && this.selection.state.tab === "output") {
					this.inspector.followLatest();
					this.layoutDirty = true;
					this.queueTick(true, true);
				}
				break;
			case "app.tasks.top":
			case "app.tasks.bottom":
				if (this.focus === "list") {
					this.select(key === "app.tasks.top" ? this.selection.rows[0]?.id : this.selection.rows.at(-1)?.id);
					this.selectedChanged();
				} else {
					const bottom = key === "app.tasks.bottom";
					if (bottom && this.selection.state.tab === "output" && !this.inspector.pagingEarlier) {
						this.inspector.followLatest();
						this.queueTick(true);
					} else {
						this.inspector.position[this.selection.state.tab].jump(bottom);
					}
					this.layoutDirty = true;
				}
				break;
			case "app.tasks.kill":
				this.requestStop();
				break;
			case "app.tasks.killAll":
				this.requestStopAll();
				break;
			case "app.tasks.confirmStop":
				this.confirmStop();
				break;
			case "app.tasks.detachSelected":
				this.detachSelected();
				break;
			case "app.tasks.help":
				this.setMode({ kind: "help", viewport: new TaskViewport() });
				break;
		}
	}
	/** Performs what a click on a rendered target asks for. */
	private perform(action: TaskAction): void {
		switch (action.kind) {
			case "select":
				this.select(action.taskId);
				this.selectedChanged();
				this.focus = "list";
				if (this.mode.kind === "search") this.finishSearch(false);
				break;
			case "tab":
				this.focus = "inspector";
				this.selection.state.tab = action.tab;
				this.layoutDirty = true;
				if (action.tab === "output") this.queueTick(true);
				break;
			case "key":
				if (action.key === "app.tasks.follow") this.focus = "inspector";
				this.action(action.key);
				break;
			case "open":
				this.open();
				break;
			case "back":
				this.escape();
				break;
		}
	}
	private move(direction: number, page = false): void {
		if (this.mode.kind === "help") {
			this.mode.viewport.move(direction, page);
			this.layoutDirty = true;
			return;
		}
		if (this.focus === "list") {
			const rows = this.selection.rows;
			if (!rows.length) return;
			const index = rows.findIndex((task) => task.id === this.selection.state.selectedId);
			const next = page
				? Math.max(0, Math.min(rows.length - 1, index + direction * (this.layout?.listPageSize ?? 1)))
				: (index + direction + rows.length) % rows.length;
			this.select(rows[next]?.id);
			this.selectedChanged();
		} else {
			const tab = this.selection.state.tab;
			const viewport = this.inspector.position[tab];
			const wasFollowing = viewport.follow;
			viewport.move(direction, page);
			this.layoutDirty = true;
			if (tab === "output" && !wasFollowing && viewport.follow) this.queueTick(true);
		}
	}
	private ensureLayout(width: number): TasksLayout {
		const height = this.options.tui.terminal.rows;
		if (
			!this.layout ||
			this.layoutDirty ||
			this.dirty ||
			this.layoutSize?.width !== width ||
			this.layoutSize?.height !== height
		) {
			this.render(width);
		}
		return this.layout!;
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		this.sync();
		this.ensureLayout(this.width);
		this.clearFeedback();
		try {
			if (this.layout?.tooSmall) {
				// The resize notice owns the screen; keys must not act on the hidden panel.
				if (this.options.keybindings.matches(data, "tui.select.cancel")) this.escape();
			} else {
				switch (this.mode.kind) {
					case "help":
						this.helpInput(this.mode.viewport, data);
						break;
					case "search":
						this.searchInput(this.mode.input, data);
						break;
					case "searchOutput":
						this.searchOutputInput(this.mode.input, data);
						break;
					case "confirmStop":
					case "confirmStopAll":
						this.confirmInput(data);
						break;
					case "browse":
						this.browseInput(data);
						break;
				}
			}
		} catch (error) {
			this.notify("error", cleanTaskText(error instanceof Error ? error.message : String(error)));
		}
		if (this.disposed) return;
		if (this.isOutputVisible() !== this.wasOutputVisible) this.queueTick();
		this.options.tui.requestRender();
	}
	private helpInput(viewport: TaskViewport, data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.tasks.help")) this.setMode(BROWSE);
		else if (kb.matches(data, "app.tasks.top") || kb.matches(data, "app.tasks.bottom"))
			viewport.jump(kb.matches(data, "app.tasks.bottom"));
		else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.editor.pageUp"))
			viewport.move(-1, kb.matches(data, "tui.editor.pageUp"));
		else if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.editor.pageDown"))
			viewport.move(1, kb.matches(data, "tui.editor.pageDown"));
	}
	private searchInput(input: Input, data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) this.escape();
		else if (kb.matches(data, "tui.select.confirm")) this.finishSearch(false);
		else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.pageUp"))
			this.move(-1, kb.matches(data, "tui.select.pageUp"));
		else if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.pageDown"))
			this.move(1, kb.matches(data, "tui.select.pageDown"));
		else {
			input.handleInput(data);
			this.selection.refresh(this.query);
			this.selectedChanged();
		}
	}
	private searchOutputInput(input: Input, data: string): void {
		const kb = this.options.keybindings;
		if (this.mode.kind !== "searchOutput") return;
		if (kb.matches(data, "tui.select.cancel")) {
			this.escape();
		} else if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.down")) {
			if (this.outputSearchMatches.length > 0) {
				this.mode.matchIndex = (this.mode.matchIndex + 1) % this.outputSearchMatches.length;
			}
			this.jumpToOutputMatch();
			this.layoutDirty = true;
		} else if (kb.matches(data, "tui.select.up")) {
			if (this.outputSearchMatches.length > 0) {
				this.mode.matchIndex =
					(this.mode.matchIndex - 1 + this.outputSearchMatches.length) % this.outputSearchMatches.length;
			}
			this.jumpToOutputMatch();
			this.layoutDirty = true;
		} else {
			input.handleInput(data);
			this.mode.matchIndex = 0;
			this.jumpToOutputMatch();
			this.layoutDirty = true;
		}
	}
	private confirmInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "app.tasks.confirmStop")) this.confirmStop();
		else if (kb.matches(data, "tui.select.cancel")) this.escape();
	}
	private browseInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.escape();
			return;
		}
		const pageUp = kb.matches(data, this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp");
		const pageDown = kb.matches(data, this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown");
		if (pageUp || kb.matches(data, "tui.select.up")) this.move(-1, pageUp);
		else if (pageDown || kb.matches(data, "tui.select.down")) this.move(1, pageDown);
		else if (kb.matches(data, "tui.select.confirm")) this.open();
		else {
			const key = actions.find((key) => kb.matches(data, key));
			if (key) this.action(key);
		}
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.ctrl || event.alt || event.shift) return;
		// Feedback is transient: a click retracts it and acts, exactly like a keypress does.
		this.clearFeedback();
		const layout = this.ensureLayout(event.width);
		const region = layout.regions.find(
			(r) => event.y >= r.y && event.y < r.y + r.height && event.x >= r.x && event.x < r.x + r.width,
		);
		if (event.type === "wheel" && event.wheelDelta) {
			if (region) {
				const delta = Math.sign(event.wheelDelta) * Math.min(20, Math.abs(event.wheelDelta));
				if (region.pane === "help") {
					if (this.mode.kind === "help") this.mode.viewport.move(delta, false);
				} else if (region.pane === "list") this.list.scroll(delta);
				else {
					const tab = this.selection.state.tab;
					const viewport = this.inspector.position[tab];
					const wasFollowing = viewport.follow;
					viewport.move(delta, false);
					if (tab === "output" && !wasFollowing && viewport.follow) this.queueTick(true);
				}
				this.layoutDirty = true;
			}
		} else if (event.type === "click" && event.button === "left") {
			const hit = layout.hits.find((hit) => hit.y === event.y && event.x >= hit.x && event.x < hit.x + hit.width);
			try {
				if (hit) this.perform(hit.action);
				else if (region && region.pane !== "help") {
					this.focus = region.pane;
					this.layoutDirty = true;
				}
			} catch (error) {
				this.notify("error", cleanTaskText(error instanceof Error ? error.message : String(error)));
			}
		} else return;
		if (this.isOutputVisible() !== this.wasOutputVisible) this.queueTick();
		this.options.tui.requestRender();
		return { handled: true, focus: event.type === "click" };
	}
	render(width: number): string[] {
		this.width = width;
		this.sync();
		if (this.isOutputVisible() !== this.wasOutputVisible) this.queueTick();
		const height = this.options.tui.terminal.rows;
		this.layout = renderTasksLayout({
			width,
			height,
			theme: this.options.theme,
			keybindings: this.options.keybindings,
			selection: this.selection,
			inspector: this.inspector,
			list: this.list,
			focus: this.focus,
			mode: this.mode,
			feedback: this.feedback,
			canDetach: (id) => this.canDetach(id),
			onOutputSearchMatches: (matchLines) => {
				this.outputSearchMatches = matchLines;
			},
		});
		this.layoutDirty = false;
		this.layoutSize = { width, height };
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
		this.clearFeedback();
		this.unsubscribe();
		this.inspector.dispose();
	}
}
