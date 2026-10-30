import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { isTaskTerminal, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { statusMarker } from "../../../modes/interactive/components/status-marker.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { TaskSelection } from "./model.ts";
import { statusName } from "./task-view.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";

interface ListRow {
	text: string;
	taskId?: string;
}

/** Spinner, ✓ and the error × are unique; every other status also needs its name. */
const SELF_EVIDENT = new Set(["running", "completed", "failed"]);

/** Right-aligned row metadata: the status name when the glyph is ambiguous, a disambiguating ID, and runtime. */
function rowMeta(task: TaskSnapshot, duplicate: boolean): string {
	return [
		SELF_EVIDENT.has(task.status) ? "" : statusName(task.status),
		duplicate ? task.id.slice(-8) : "",
		runtimeLabel(task),
	]
		.filter(Boolean)
		.join(" · ");
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
		const labels = selection.rows.map((task) => cleanTaskText(task.label));
		const labelWidth = Math.max(0, ...labels.map((label) => visibleWidth(label)));
		const titles = selection.rows.map((task) => cleanTaskText(firstCommandLine(task.title)));
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
			const label = labels[index]!;
			const duplicate = titles.some((title, other) => other !== index && title === titles[index]);
			const meta = rowMeta(task, duplicate);
			// Labels form an aligned source column so titles start together.
			const source = labelWidth ? `${label}${" ".repeat(labelWidth - visibleWidth(label))} ` : "";
			const head = visibleWidth(marker.glyph) + 1 + visibleWidth(source);
			const title = truncateToWidth(titles[index]!, Math.max(1, width - head - visibleWidth(meta) - 1), "…");
			const gap = Math.max(1, width - head - visibleWidth(title) - visibleWidth(meta));
			const text = `${theme.fg(marker.color, marker.glyph)} ${theme.fg("dim", source)}${theme.fg("text", title)}${" ".repeat(gap)}${theme.fg("muted", meta)}`;
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
			const next = anchor ? rows.findIndex((row) => row.taskId === anchor) : -1;
			if (next >= 0) this.start = next;
		}
		if (selectedLine >= 0 && (!sameSelection || this.reveal || selectedWasVisible)) {
			// Revealing the first task of a group keeps its heading in view.
			const top = rows[selectedLine - 1]?.taskId === undefined ? selectedLine - 1 : selectedLine;
			if (top < this.start) this.start = Math.max(0, top);
			else if (selectedLine >= this.start + height) this.start = selectedLine + 1 - height;
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
		const ids = this.rows.flatMap((row) => (row.taskId ? [row.taskId] : []));
		const visible = this.rows
			.slice(this.start, this.start + this.height)
			.flatMap((row) => (row.taskId ? [row.taskId] : []));
		return `Tasks ${ids.indexOf(visible[0]!) + 1}-${ids.indexOf(visible.at(-1)!) + 1} of ${ids.length}`;
	}
}
