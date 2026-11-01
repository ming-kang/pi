import type { Input } from "@earendil-works/pi-tui";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { isTaskTerminal, type TaskSnapshot } from "../../../core/tasks/types.ts";
import type { TaskViewport } from "./viewport.ts";

export type TasksTab = "output" | "info";
export type PanelFocus = "list" | "inspector";

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
	| { kind: "confirmStop"; taskId: string }
	| { kind: "help"; viewport: TaskViewport };

/** A task can be asked to stop while it is neither settled nor already stopping. */
export function isStoppable(task: Pick<TaskSnapshot, "status">): boolean {
	return !isTaskTerminal(task.status) && task.status !== "stopping";
}

/** Remember navigation within one runtime, without retaining output or execution handles. */
export interface TasksPanelState {
	tab: TasksTab;
	selectedId?: string;
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
	get selected(): TaskSnapshot | undefined {
		return this.rows.find((task) => task.id === this.state.selectedId);
	}
	get activeCount(): number {
		return this.all.filter((task) => !isTaskTerminal(task.status)).length;
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
	/** Rows are the retained tasks matching `query`; an empty query matches all of them. */
	refresh(query = ""): void {
		const { selectedId } = this.state;
		const active = this.all
			.filter((task) => !isTaskTerminal(task.status))
			.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		const history = this.all
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
