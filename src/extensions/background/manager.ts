/**
 * /bg task manager — an inline, /model-style menu that mounts in the editor
 * slot. Two views in one component: a task list, and a live output viewport
 * for the selected task (Enter to open, Esc to go back). The host dependency
 * is narrowed to three callbacks so the component stays testable.
 */

import { type Component, type Focusable, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { type BgTask, firstCommandLine, formatDuration, type OutputSlice } from "./registry.ts";
import { statusColor, statusGlyph } from "./render.ts";

const POLL_INTERVAL_MS = 1000;
const VIEW_TAIL_BYTES = 128 * 1024;
const MAX_VIEW_LINES = 2000;
const LIST_MAX_VISIBLE = 10;
const LIST_MIN_VISIBLE = 3;
/** Rows outside the task list itself (borders, title, counter, footer, padding). */
const LIST_RESERVED_ROWS = 14;

export interface BackgroundManagerHost {
	listTasks(): BgTask[];
	killTask(id: string): { killed: boolean };
	readSlice(filePath: string, options: { mode: "tail"; maxBytes: number }): Promise<OutputSlice>;
}

interface MenuTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

export interface BackgroundTasksMenuOptions {
	tui: MenuTui;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	host: BackgroundManagerHost;
	onClose: () => void;
	pollIntervalMs?: number;
}

interface TailCache {
	taskId: string;
	lines: string[];
	totalBytes: number;
	/** True once a terminal task's final output has been read; skips re-reads. */
	settledRead?: boolean;
	error?: string;
}

/** Truncate to an exact visible width, padding short lines with spaces. */
function padLine(line: string, width: number): string {
	return truncateToWidth(line, width, "…", true);
}

export class BackgroundTasksMenu implements Component, Focusable {
	private readonly tui: MenuTui;
	private readonly theme: Theme;
	private readonly keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	private readonly host: BackgroundManagerHost;
	private readonly onClose: () => void;
	private readonly pollIntervalMs: number;

	private view: "list" | "detail" = "list";
	private tasks: BgTask[] = [];
	private selectedTaskId: string | undefined;
	private listScrollTop = 0;
	private follow = true;
	private tailOffsetLines = 0;
	private tailCache: TailCache | undefined;
	private killFeedback: string | undefined;
	/** Task whose settle expires killFeedback; undefined = persists until the next key. */
	private killFeedbackTaskId: string | undefined;
	/** Last tick's render signature; unchanged means nothing visible moved. */
	private lastSignature = "";
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private readBusy = false;
	private disposed = false;
	private _focused = false;

	constructor(options: BackgroundTasksMenuOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.host = options.host;
		this.onClose = options.onClose;
		this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

		this.tasks = this.host.listTasks();
		this.selectedTaskId = this.tasks[0]?.id;
		void this.tick();
		this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {
		// No cached render state; the poller drives refresh.
	}

	dispose(): void {
		this.disposed = true;
		if (this.pollTimer !== undefined) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	handleInput(data: string): void {
		if (this.killFeedback !== undefined) {
			this.killFeedback = undefined;
			this.killFeedbackTaskId = undefined;
			this.tui.requestRender();
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.view === "detail") {
				this.view = "list";
				this.tui.requestRender();
			} else {
				this.onClose();
			}
			return;
		}
		if (this.keybindings.matches(data, "app.backgroundTasks.kill")) {
			this.killSelected();
			return;
		}
		if (this.view === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
	}

	private handleListInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (!this.selectedTask()) return;
			this.view = "detail";
			this.resetFollow();
			this.tui.requestRender();
		}
	}

	private handleDetailInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollDetail(Math.max(1, this.detailBodyHeight()));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			if (!this.follow) this.scrollDetail(-Math.max(1, this.detailBodyHeight()));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollDetail(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (!this.follow) this.scrollDetail(-1);
		}
	}

	/** Scroll the detail viewport by `lines` (positive = back through history). */
	private scrollDetail(lines: number): void {
		if (lines > 0) {
			const max = this.maxTailOffset();
			if (max === 0) return; // Nothing above the viewport to scroll back to.
			this.follow = false;
			this.tailOffsetLines = Math.min(max, this.tailOffsetLines + lines);
		} else {
			if (this.follow) return;
			this.tailOffsetLines = Math.max(0, this.tailOffsetLines + lines);
			if (this.tailOffsetLines === 0) {
				this.follow = true;
				void this.refreshViewport();
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const body = this.view === "list" ? this.renderList(width) : this.renderDetail(width);
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		return [border, ...body, padLine(this.footerLine(), width), border];
	}

	// ── list view ──────────────────────────────────────────────────────────

	/** Task rows the terminal can spare; short windows trade rows for the transcript. */
	private listMaxVisible(): number {
		return Math.min(LIST_MAX_VISIBLE, Math.max(LIST_MIN_VISIBLE, this.tui.terminal.rows - LIST_RESERVED_ROWS));
	}

	private renderList(width: number): string[] {
		const lines: string[] = [];
		const counts = this.countsLabel();
		const title = counts ? `Background tasks — ${counts}` : "Background tasks";
		lines.push(padLine(this.theme.fg("accent", this.theme.bold(title)), width));

		if (this.tasks.length === 0) {
			lines.push(padLine(this.theme.fg("muted", "  (no tasks)"), width));
			return lines;
		}

		const selected = this.selectedTask();
		const maxVisible = this.listMaxVisible();
		const visible = this.tasks.slice(this.listScrollTop, this.listScrollTop + maxVisible);
		let seenRunning = false;
		for (const task of visible) {
			// listTasks() orders running first, finished after: one separator at the boundary.
			if (seenRunning && task.status !== "running") {
				lines.push(padLine(this.theme.fg("muted", "  ── finished ──"), width));
				seenRunning = false;
			}
			if (task.status === "running") seenRunning = true;
			lines.push(this.renderTaskRow(task, task === selected, width));
		}
		if (this.tasks.length > maxVisible) {
			const index = this.tasks.findIndex((task) => task.id === this.selectedTaskId);
			lines.push(padLine(this.theme.fg("muted", `  (${index + 1}/${this.tasks.length})`), width));
		}
		return lines;
	}

	private renderTaskRow(task: BgTask, isSelected: boolean, width: number): string {
		const duration = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
		const label = task.description
			? `${task.description} — ${firstCommandLine(task.command)}`
			: firstCommandLine(task.command);
		if (isSelected) {
			// Pad to full width before styling so the selection background spans the row.
			const plain = padLine(`→ ${statusGlyph(task.status, task.stalled)} ${task.id} ${duration} ${label}`, width);
			return this.theme.bg("selectedBg", this.theme.fg("text", plain));
		}
		const glyph = this.theme.fg(statusColor(task.status, task.stalled), statusGlyph(task.status, task.stalled));
		const id = this.theme.fg("accent", task.id);
		const rest = this.theme.fg("muted", `${duration} ${label}`);
		return padLine(`  ${glyph} ${id} ${rest}`, width);
	}

	private countsLabel(): string {
		let running = 0;
		for (const task of this.tasks) if (task.status === "running") running++;
		const ended = this.tasks.length - running;
		const parts: string[] = [];
		if (running > 0) parts.push(`${running} running`);
		if (ended > 0) parts.push(`${ended} done`);
		return parts.join(" · ");
	}

	// ── detail view ────────────────────────────────────────────────────────

	private renderDetail(width: number): string[] {
		const task = this.selectedTask();
		const lines: string[] = [padLine(this.detailHeader(task), width)];
		const height = this.detailBodyHeight();
		const cache = task && this.tailCache?.taskId === task.id ? this.tailCache : undefined;
		if (cache?.error) {
			lines.push(padLine(this.theme.fg("error", `Cannot read output: ${cache.error}`), width));
			for (let row = 1; row < height; row++) lines.push(padLine("", width));
			return lines;
		}
		const content = cache?.lines ?? [];
		const fromEnd = this.follow ? 0 : this.tailOffsetLines;
		const start = content.length - height - fromEnd;
		for (let row = 0; row < height; row++) {
			const line = content[start + row];
			lines.push(line === undefined ? padLine("", width) : padLine(this.theme.fg("toolOutput", line), width));
		}
		return lines;
	}

	private detailHeader(task: BgTask | undefined): string {
		if (!task) return this.theme.fg("muted", "(no task selected)");
		const duration = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
		const exit = task.exitCode !== undefined && task.exitCode !== null ? ` exit ${task.exitCode}` : "";
		const resumeLabel = keyLabel("tui.select.pageDown", { keybindings: this.keybindings });
		const paused = this.follow ? "" : resumeLabel ? ` — paused (${resumeLabel} to follow)` : " — paused";
		const fileName = task.outputPath.replace(/\\/g, "/").split("/").at(-1) ?? task.outputPath;
		const glyph = this.theme.fg(statusColor(task.status, task.stalled), statusGlyph(task.status, task.stalled));
		const statusLabel = task.stalled ? "running, waiting for input" : task.status;
		const header = `${task.id} · ${statusLabel}${exit} · ${duration} · ${formatSize(task.outputBytes)} · ${fileName}${paused}`;
		return `${glyph} ${this.theme.fg("muted", header)}`;
	}

	private detailBodyHeight(): number {
		// Inline component: keep the chat transcript visible above the menu.
		return Math.min(20, Math.max(4, this.tui.terminal.rows - 8));
	}

	// ── shared behavior ────────────────────────────────────────────────────

	private footerLine(): string {
		if (this.killFeedback) return this.theme.fg("warning", this.killFeedback);
		const opts = { keybindings: this.keybindings };
		const parts =
			this.view === "list"
				? [
						`${keyLabel("tui.select.up", opts)}/${keyLabel("tui.select.down", opts)} select`,
						`${keyLabel("tui.select.confirm", opts)} output`,
						`${keyLabel("app.backgroundTasks.kill", opts)} kill`,
						`${keyLabel("tui.select.cancel", opts)} close`,
					]
				: [
						`${keyLabel("tui.select.up", opts)}/${keyLabel("tui.select.down", opts)} scroll`,
						`${keyLabel("tui.select.pageUp", opts)}/${keyLabel("tui.select.pageDown", opts)} page`,
						`${keyLabel("app.backgroundTasks.kill", opts)} kill`,
						`${keyLabel("tui.select.cancel", opts)} back`,
					];
		return this.theme.fg("dim", parts.join(" · "));
	}

	private selectedTask(): BgTask | undefined {
		return this.tasks.find((task) => task.id === this.selectedTaskId);
	}

	private moveSelection(offset: -1 | 1): void {
		if (this.tasks.length === 0) return;
		const current = this.tasks.findIndex((task) => task.id === this.selectedTaskId);
		const next = (current + offset + this.tasks.length) % this.tasks.length;
		const task = this.tasks[next];
		if (!task) return;
		this.selectedTaskId = task.id;
		if (next < this.listScrollTop) this.listScrollTop = next;
		if (next >= this.listScrollTop + this.listMaxVisible()) {
			this.listScrollTop = next - this.listMaxVisible() + 1;
		}
		this.resetFollow();
		this.tui.requestRender();
	}

	private resetFollow(): void {
		this.follow = true;
		this.tailOffsetLines = 0;
		this.tailCache = undefined;
		void this.refreshViewport();
	}

	private currentLines(): string[] {
		const task = this.selectedTask();
		const cache = this.tailCache;
		return task && cache && cache.taskId === task.id ? cache.lines : [];
	}

	private maxTailOffset(): number {
		return Math.max(0, this.currentLines().length - this.detailBodyHeight());
	}

	private killSelected(): void {
		const task = this.selectedTask();
		if (!task) return;
		if (task.status !== "running") {
			this.killFeedback = `${task.id} is not running`;
			this.tui.requestRender();
			return;
		}
		this.host.killTask(task.id);
		// Terminal state lands on the next poll; the feedback expires with it (tick).
		this.killFeedback = `stopping ${task.id}…`;
		this.killFeedbackTaskId = task.id;
		this.tui.requestRender();
	}

	private async tick(): Promise<void> {
		if (this.disposed) return;
		this.tasks = this.host.listTasks();
		if (!this.selectedTask() && this.tasks[0]) this.selectedTaskId = this.tasks[0].id;
		this.expireKillFeedback();
		// A pending re-read counts as a change: refreshViewport may skip this tick
		// (readBusy), and the signature alone would let that retry be dropped.
		const needsRead = this.view === "detail" && this.follow && this.detailOutputChanged();
		if (!needsRead && this.renderSignature() === this.lastSignature) return; // Nothing visible changed.
		if (needsRead) await this.refreshViewport();
		this.lastSignature = this.renderSignature();
		this.tui.requestRender();
	}

	/** Drop "stopping" feedback once its task has settled. */
	private expireKillFeedback(): void {
		if (this.killFeedbackTaskId === undefined) return;
		const task = this.tasks.find((candidate) => candidate.id === this.killFeedbackTaskId);
		if (!task || task.status !== "running") {
			this.killFeedback = undefined;
			this.killFeedbackTaskId = undefined;
		}
	}

	/** Everything the rendered output depends on; equal signatures need no redraw. */
	private renderSignature(): string {
		const parts = [
			this.view,
			this.selectedTaskId ?? "",
			String(this.listScrollTop),
			String(this.follow),
			String(this.tailOffsetLines),
			this.killFeedback ?? "",
			this.tailCache
				? `${this.tailCache.taskId}:${this.tailCache.lines.length}:${this.tailCache.totalBytes}:${this.tailCache.error ?? ""}:${String(this.tailCache.settledRead ?? false)}`
				: "",
		];
		for (const task of this.tasks) {
			const duration = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
			parts.push(
				`${task.id}:${task.status}:${String(task.stalled)}:${task.outputBytes}:${task.exitCode ?? ""}:${duration}`,
			);
		}
		return parts.join("|");
	}

	/** True when the detail viewport must re-read the output file this tick. */
	private detailOutputChanged(): boolean {
		const task = this.selectedTask();
		if (!task) return false;
		const cache = this.tailCache;
		if (!cache || cache.taskId !== task.id) return true;
		if (cache.error !== undefined) return true; // Keep retrying; failed reads are cheap.
		if (task.status !== "running") {
			// Terminal task: the file is final — read it once, then never again.
			return cache.settledRead !== true;
		}
		return cache.totalBytes !== task.outputBytes;
	}

	private async refreshViewport(): Promise<void> {
		if (this.readBusy) return;
		const task = this.selectedTask();
		if (!task) return;
		this.readBusy = true;
		try {
			const slice = await this.host.readSlice(task.outputPath, { mode: "tail", maxBytes: VIEW_TAIL_BYTES });
			if (this.disposed || this.selectedTaskId !== task.id || !this.follow) return;
			this.tailCache = {
				taskId: task.id,
				lines: toViewLines(slice.text),
				totalBytes: slice.totalBytes,
				settledRead: task.status !== "running",
			};
		} catch (error) {
			if (this.disposed || this.selectedTaskId !== task.id) return;
			this.tailCache = {
				taskId: task.id,
				lines: [],
				totalBytes: task.outputBytes,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.readBusy = false;
		}
	}
}

function toViewLines(text: string): string[] {
	// Strip ANSI first: sanitize would remove the escape bytes alone, leaving
	// orphaned "[31m" fragments that strip can no longer see.
	const lines = sanitizeBinaryOutput(stripTerminalSequences(text)).split("\n");
	// Drop the trailing empty line produced by a final newline, then bound the
	// window: a 128KB slice of one-byte lines must never become 128k rows.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-MAX_VIEW_LINES);
}
