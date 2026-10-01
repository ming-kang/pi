import { isInlineLogTask, isTaskTerminal, type TaskSnapshot } from "../../../core/tasks/types.ts";

export type TasksFilter = "overview" | "active" | "history";
export type TasksTab = "output" | "info";

/** Remember navigation within one runtime, without retaining output or execution handles. */
export interface TasksPanelState {
	filter: TasksFilter;
	tab: TasksTab;
	query: string;
	selectedId?: string;
}

/** Selection follows identity, including when its row moves from active work into history. */
export class TaskSelection {
	readonly state: TasksPanelState;
	all: TaskSnapshot[] = [];
	rows: TaskSnapshot[] = [];
	private justFinishedId?: string;
	constructor(state: TasksPanelState) {
		this.state = state;
	}
	get selected(): TaskSnapshot | undefined {
		return this.rows.find((task) => task.id === this.state.selectedId);
	}
	get activeCount(): number {
		return this.all.filter((task) => !isTaskTerminal(task.status)).length;
	}
	get recentCount(): number {
		return this.all.filter((task) => isTaskTerminal(task.status) && !isInlineLogTask(task)).length;
	}
	sync(all: TaskSnapshot[]): void {
		const previous = this.selected;
		const next = all.find((task) => task.id === previous?.id);
		if (
			this.state.filter === "active" &&
			previous &&
			!isTaskTerminal(previous.status) &&
			next &&
			isTaskTerminal(next.status)
		)
			this.justFinishedId = next.id;
		this.all = all;
		this.refresh();
	}
	select(id: string | undefined): void {
		this.state.selectedId = id;
		if (id !== this.justFinishedId) this.justFinishedId = undefined;
		this.refresh();
	}
	filter(filter: TasksFilter): void {
		this.state.filter = filter;
		this.justFinishedId = undefined;
		this.refresh();
	}
	refresh(): void {
		const { filter, selectedId, query } = this.state;
		const active = this.all
			.filter((task) => !isTaskTerminal(task.status))
			.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		const history = this.all
			.filter((task) => isTaskTerminal(task.status))
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.id.localeCompare(b.id));
		const recent = history.filter((task) => !isInlineLogTask(task)).slice(0, 5);
		const watched = history.find((task) => task.id === selectedId);
		if (watched && !recent.includes(watched)) recent.push(watched);
		const finished = filter === "active" ? history.filter((task) => task.id === this.justFinishedId) : recent;
		const rows = filter === "history" ? history : [...active, ...finished];
		const search = query.toLocaleLowerCase().trim();
		this.rows = search
			? rows.filter((task) =>
					`${task.title}\n${task.command ?? ""}\n${task.kind}\n${task.id}`.toLocaleLowerCase().includes(search),
				)
			: rows;
		if (!this.rows.some((task) => task.id === selectedId)) this.state.selectedId = this.rows[0]?.id;
	}
	group(task: TaskSnapshot): string {
		if (!isTaskTerminal(task.status)) return "Active";
		return this.state.filter === "active"
			? "Just finished"
			: this.state.filter === "history"
				? "Retained history"
				: "Recent results";
	}
}
