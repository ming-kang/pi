import { isTaskTerminal, type TaskSnapshot } from "../../../core/tasks/types.ts";

export type TasksTab = "output" | "info";

/** Remember navigation within one runtime, without retaining output or execution handles. */
export interface TasksPanelState {
	tab: TasksTab;
	selectedId?: string;
}

/** Selection follows identity, including when its row moves from active work into history. */
export class TaskSelection {
	readonly state: TasksPanelState;
	all: TaskSnapshot[] = [];
	rows: TaskSnapshot[] = [];
	query = "";
	constructor(state: TasksPanelState) {
		this.state = state;
	}
	get selected(): TaskSnapshot | undefined {
		return this.rows.find((task) => task.id === this.state.selectedId);
	}
	get activeCount(): number {
		return this.all.filter((task) => !isTaskTerminal(task.status)).length;
	}
	sync(all: TaskSnapshot[]): void {
		this.all = all;
		this.refresh();
	}
	select(id: string | undefined): void {
		this.state.selectedId = id;
		this.refresh();
	}
	refresh(): void {
		const { selectedId } = this.state;
		const active = this.all
			.filter((task) => !isTaskTerminal(task.status))
			.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		const history = this.all
			.filter((task) => isTaskTerminal(task.status))
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.id.localeCompare(b.id));
		const rows = [...active, ...history];
		const search = this.query.toLocaleLowerCase().trim();
		this.rows = search
			? rows.filter((task) =>
					`${task.title}\n${task.command ?? ""}\n${task.kind}\n${task.id}`.toLocaleLowerCase().includes(search),
				)
			: rows;
		if (!this.rows.some((task) => task.id === selectedId)) this.state.selectedId = this.rows[0]?.id;
	}
}
