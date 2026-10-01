import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import { statusMarker } from "../components/status-marker.ts";
import type { Theme } from "../theme/theme.ts";
import type { TaskSelection } from "./model.ts";
import { statusName } from "./task-view.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";

interface ListRow {
	text: string;
	taskId?: string;
}

/** Keeps list scrolling independent of selection, with an identity anchor on reordering. */
export class TaskList {
	private start = 0;
	private height = 1;
	private rows: ListRow[] = [];
	private selectedId?: string;
	private selectedLine = -1;
	private reveal = false;
	showSelection(): void {
		this.reveal = true;
	}
	scroll(delta: number): void {
		this.start = Math.max(0, Math.min(Math.max(0, this.rows.length - this.height), this.start + delta));
	}
	render(selection: TaskSelection, theme: Theme, width: number, height: number): ListRow[] {
		const rows: ListRow[] = [];
		const labels = selection.rows.map((task) => cleanTaskText(firstCommandLine(task.command ?? task.title)));
		const fitted = labels.map((label) => truncateToWidth(label, Math.max(1, width - 3), "…"));
		let group = "",
			selectedLine = -1;
		for (const [index, task] of selection.rows.entries()) {
			const nextGroup = isTaskTerminal(task.status) ? "Finished" : "Active";
			if (nextGroup !== group) {
				rows.push({ text: theme.fg("dim", nextGroup) });
				group = nextGroup;
			}
			const selected = task.id === selection.state.selectedId;
			if (selected) selectedLine = rows.length;
			const marker = statusMarker(task.status, { now: Date.now() });
			const duplicate = fitted.some((label, other) => other !== index && label === fitted[index]);
			const meta = `${runtimeLabel(task)}${duplicate ? ` · ${task.id.slice(-8)}` : ""}`;
			const texts = [
				`${theme.fg(marker.color, marker.glyph)} ${theme.fg("text", labels[index]!)}`,
				`  ${theme.fg(marker.color, statusName(task.status))}${theme.fg("muted", ` · ${meta}`)}`,
			];
			for (const text of texts) {
				const padded = truncateToWidth(text, width, "…", true);
				// The system theme has no panel backgrounds until the terminal reports its colors.
				rows.push({
					text: !selected
						? padded
						: theme.getBgAnsi("selectedBg") === "\x1b[49m"
							? theme.style(stripTerminalSequences(padded), { inverse: true })
							: theme.bg("selectedBg", padded),
					taskId: task.id,
				});
			}
		}
		if (!rows.length)
			rows.push({ text: theme.fg("muted", selection.query ? "No matching tasks." : "No retained tasks.") });
		const sameSelection = this.selectedId === selection.state.selectedId;
		const selectedWasVisible =
			sameSelection &&
			this.selectedLine >= this.start &&
			this.selectedLine < this.start + this.height &&
			selectedLine >= 0;
		if (selectedWasVisible) this.start += selectedLine - this.selectedLine;
		else {
			const anchor = this.rows[this.start]?.taskId;
			const offset = anchor && this.rows[this.start - 1]?.taskId === anchor ? 1 : 0;
			const next = anchor ? rows.findIndex((row) => row.taskId === anchor) : -1;
			if (next >= 0) this.start = next + offset;
		}
		if (selectedLine >= 0 && (!sameSelection || this.reveal || selectedWasVisible)) {
			if (selectedLine < this.start) this.start = selectedLine;
			else if (selectedLine + 1 >= this.start + height) this.start = selectedLine + 2 - height;
		}
		this.start = Math.max(0, Math.min(Math.max(0, rows.length - height), this.start));
		this.rows = rows;
		this.height = height;
		this.selectedId = selection.state.selectedId;
		this.selectedLine = selectedLine;
		this.reveal = false;
		return rows.slice(this.start, this.start + height);
	}
	get range(): string {
		if (this.rows.length <= this.height) return "";
		const ids = [...new Set(this.rows.flatMap((row) => (row.taskId ? [row.taskId] : [])))];
		const visible = this.rows
			.slice(this.start, this.start + this.height)
			.flatMap((row) => (row.taskId ? [row.taskId] : []));
		return `Tasks ${ids.indexOf(visible[0]!) + 1}-${ids.indexOf(visible.at(-1)!) + 1} of ${ids.length}`;
	}
}
