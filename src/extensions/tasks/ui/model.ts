import type { Input } from "@earendil-works/pi-tui";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { isTaskTerminal, type TaskSnapshot } from "../../../core/tasks/types.ts";
import type { TaskViewport } from "./viewport.ts";

export type TasksTab = "output" | "info";
export type PanelFocus = "list" | "inspector";
export const TASK_LIST_FILTERS = ["all", "active", "background", "failed"] as const;
export type TaskListFilter = (typeof TASK_LIST_FILTERS)[number];

/** What activating a rendered cell does; the manager dispatches on `kind` alone. */
export type TaskAction =
	| { kind: "select"; taskId: string }
	| { kind: "tab"; tab: TasksTab }
	| { kind: "key"; key: AppKeybinding }
	| { kind: "open" }
	/** Escape: unwind one layer, return from the inspector in a narrow terminal, or close the panel. */
	| { kind: "back" };

/** A clickable row of cells on the screen and the action a click on it performs. */
export interface TaskHit {
	x: number;
	y: number;
	width: number;
	action: TaskAction;
}

/**
 * The one transient layer over the browsing panel. Each layer owns its data, so a stale
 * combination (help over a confirmation, a restore point without a search) cannot exist.
 */
export type PanelMode =
	| { kind: "browse" }
	/** Searching moves focus to the list; `restore` is where Esc returns to. The input owns the query. */
	| { kind: "search"; restore: { id?: string; focus: PanelFocus }; input: Input }
	| { kind: "searchOutput"; restore: { focus: PanelFocus }; input: Input; matchIndex: number }
	| { kind: "confirmStop"; taskId: string }
	| { kind: "confirmStopAll"; count: number }
	| { kind: "help"; viewport: TaskViewport };

/** A task can be asked to stop while it is neither settled nor already stopping. */
export function isStoppable(task: Pick<TaskSnapshot, "status">): boolean {
	return !isTaskTerminal(task.status) && task.status !== "stopping";
}

function matchesFilter(task: TaskSnapshot, filter: TaskListFilter): boolean {
	switch (filter) {
		case "all":
			return true;
		case "active":
			return !isTaskTerminal(task.status);
		case "background":
			return task.mode === "background";
		case "failed":
			return task.status === "failed" || task.status === "timeout" || task.status === "partial";
	}
}

/** Remember navigation within one runtime, without retaining output or execution handles. */
export interface TasksPanelState {
	tab: TasksTab;
	selectedId?: string;
	filter?: TaskListFilter;
	/** When the panel last closed; reopening selects work started since then. */
	closedAt?: number;
}

/** Selection follows identity, including when its row moves from active work into history. */
export class TaskSelection {
	readonly state: TasksPanelState;
	all: TaskSnapshot[] = [];
	rows: TaskSnapshot[] = [];
	constructor(state: TasksPanelState) {
		this.state = state;
	}
	get filter(): TaskListFilter {
		return this.state.filter ?? "all";
	}
	get selected(): TaskSnapshot | undefined {
		return this.rows.find((task) => task.id === this.state.selectedId);
	}
	get activeCount(): number {
		return this.all.filter((task) => !isTaskTerminal(task.status)).length;
	}
	stoppable(): TaskSnapshot[] {
		return this.all.filter(isStoppable);
	}
	cycleFilter(query = ""): TaskListFilter {
		const index = TASK_LIST_FILTERS.indexOf(this.filter);
		const next = TASK_LIST_FILTERS[(index + 1) % TASK_LIST_FILTERS.length]!;
		this.state.filter = next === "all" ? undefined : next;
		this.refresh(query);
		return next;
	}
	sync(all: TaskSnapshot[], query = ""): void {
		this.all = all;
		this.refresh(query);
	}
	select(id: string | undefined, query = ""): void {
		this.state.selectedId = id;
		this.refresh(query);
	}
	/** On reopen, prefer the newest work started since the panel closed over the remembered row. */
	selectStartedSinceClose(): void {
		const { closedAt } = this.state;
		if (closedAt === undefined) return;
		const fresh = this.rows.filter((task) => task.startedAt > closedAt);
		if (fresh.length) this.select(fresh.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).id);
	}
	/** Rows are the retained tasks matching the active filter and `query`. */
	refresh(query = ""): void {
		const { selectedId } = this.state;
		const filtered = this.all.filter((task) => matchesFilter(task, this.filter));
		const active = filtered
			.filter((task) => !isTaskTerminal(task.status))
			.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		const history = filtered
			.filter((task) => isTaskTerminal(task.status))
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.id.localeCompare(b.id));
		const rows = [...active, ...history];
		const search = query.toLocaleLowerCase().trim();
		this.rows = search
			? rows.filter((task) =>
					`${task.title}\n${task.input?.text ?? ""}\n${task.label}\n${task.kind}\n${task.id}`
						.toLocaleLowerCase()
						.includes(search),
				)
			: rows;
		if (!this.rows.some((task) => task.id === selectedId)) this.state.selectedId = this.rows[0]?.id;
	}
}
