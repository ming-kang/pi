/**
 * /bg task manager — a two-pane overlay: task list on the left, a live output
 * viewport on the right. Rows are hand-composed for exact width control; the
 * host dependency is narrowed to three callbacks so the component stays
 * testable with a fake host.
 */

import {
	type Component,
	type Focusable,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { type BgTask, firstCommandLine, formatDuration, type OutputSlice } from "./registry.ts";

const POLL_INTERVAL_MS = 1000;
const VIEW_TAIL_BYTES = 128 * 1024;
const MAX_VIEW_LINES = 2000;

export interface BackgroundManagerHost {
	listTasks(): BgTask[];
	killTask(id: string): { killed: boolean };
	readSlice(filePath: string, options: { mode: "tail"; maxBytes: number }): Promise<OutputSlice>;
}

interface OverlayTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

export interface BackgroundTasksOverlayOptions {
	tui: OverlayTui;
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
	error?: string;
}

function statusGlyph(task: BgTask): string {
	switch (task.status) {
		case "running":
			return "●";
		case "completed":
			return "✓";
		case "killed":
			return "○";
		default:
			return "✗";
	}
}

/** Pad a line with spaces to an exact visible width (used for both panes). */
function padLine(line: string, width: number): string {
	return truncateToWidth(line, width) + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function sizeLabel(task: BgTask): string {
	return formatSize(task.outputBytes);
}

export class BackgroundTasksOverlay implements Component, Focusable {
	private readonly tui: OverlayTui;
	private readonly theme: Theme;
	private readonly keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	private readonly host: BackgroundManagerHost;
	private readonly onClose: () => void;
	private readonly pollIntervalMs: number;

	private tasks: BgTask[] = [];
	private selectedTaskId: string | undefined;
	private listScrollTop = 0;
	private follow = true;
	private tailOffsetLines = 0;
	private tailCache: TailCache | undefined;
	private killFeedback: string | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private tickBusy = false;
	private disposed = false;
	private _focused = false;

	constructor(options: BackgroundTasksOverlayOptions) {
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
		this.killFeedback = undefined;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			const page = Math.max(1, this.layoutBodyHeight());
			if (this.follow) this.freeze(page);
			else this.tailOffsetLines += page;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			if (!this.follow) {
				const page = Math.max(1, this.layoutBodyHeight());
				this.tailOffsetLines = Math.max(0, this.tailOffsetLines - page);
				if (this.tailOffsetLines === 0) {
					this.follow = true;
					void this.refreshViewport();
				} else {
					this.tui.requestRender();
				}
			}
			return;
		}
		if (this.keybindings.matches(data, "app.backgroundTasks.kill")) {
			this.killSelected();
		}
	}

	render(width: number): string[] {
		const { listWidth, viewWidth, bodyHeight } = this.layout(width);
		const lines: string[] = [];
		lines.push(this.theme.fg("border", "─".repeat(Math.max(1, width))));

		const counts = this.countsLabel();
		const title = counts ? `Background tasks — ${counts}` : "Background tasks";
		lines.push(padLine(this.theme.fg("accent", this.theme.bold(title)), width));

		const tasks = this.visibleList(bodyHeight);
		const selected = this.selectedTask();
		for (let row = 0; row < bodyHeight; row++) {
			const left = this.renderTaskRow(tasks[row], selected, listWidth);
			const right = this.renderViewportRow(selected, row, viewWidth, bodyHeight);
			lines.push(`${left}${this.theme.fg("border", " │ ")}${right}`);
		}

		lines.push(padLine(this.hintsLine(), width));
		lines.push(this.theme.fg("border", "─".repeat(Math.max(1, width))));
		return lines;
	}

	private layout(width: number): { listWidth: number; viewWidth: number; bodyHeight: number } {
		const listWidth = Math.min(44, Math.max(24, Math.floor(width * 0.35)));
		const bodyHeight = this.layoutBodyHeight();
		return { listWidth, viewWidth: Math.max(10, width - listWidth - 3), bodyHeight };
	}

	private layoutBodyHeight(): number {
		// Border + title + hints + border chrome; leave room for overlay padding.
		return Math.min(30, Math.max(4, this.tui.terminal.rows - 8));
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

	private selectedTask(): BgTask | undefined {
		return this.tasks.find((task) => task.id === this.selectedTaskId);
	}

	private visibleList(bodyHeight: number): BgTask[] {
		return this.tasks.slice(this.listScrollTop, this.listScrollTop + bodyHeight);
	}

	private moveSelection(offset: -1 | 1): void {
		if (this.tasks.length === 0) return;
		const current = this.tasks.findIndex((task) => task.id === this.selectedTaskId);
		const next = (current + offset + this.tasks.length) % this.tasks.length;
		this.selectIndex(next);
	}

	private selectIndex(index: number): void {
		const task = this.tasks[index];
		if (!task) return;
		this.selectedTaskId = task.id;
		this.resetFollow();
		const bodyHeight = this.layoutBodyHeight();
		if (index < this.listScrollTop) this.listScrollTop = index;
		if (index >= this.listScrollTop + bodyHeight) this.listScrollTop = index - bodyHeight + 1;
		this.tui.requestRender();
	}

	private resetFollow(): void {
		this.follow = true;
		this.tailOffsetLines = 0;
		this.tailCache = undefined;
		void this.refreshViewport();
	}

	private freeze(page: number): void {
		this.follow = false;
		this.tailOffsetLines = page;
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
		this.killFeedback = `killed ${task.id}`;
		this.tui.requestRender();
	}

	private async tick(): Promise<void> {
		if (this.disposed) return;
		this.tasks = this.host.listTasks();
		if (!this.selectedTask() && this.tasks[0]) this.selectedTaskId = this.tasks[0].id;
		if (this.follow) await this.refreshViewport();
		this.tui.requestRender();
	}

	private async refreshViewport(): Promise<void> {
		if (this.tickBusy) return;
		const task = this.selectedTask();
		if (!task) return;
		this.tickBusy = true;
		try {
			const slice = await this.host.readSlice(task.outputPath, { mode: "tail", maxBytes: VIEW_TAIL_BYTES });
			if (this.disposed || this.selectedTaskId !== task.id || !this.follow) return;
			this.tailCache = { taskId: task.id, lines: toViewLines(slice.text), totalBytes: slice.totalBytes };
		} catch (error) {
			if (this.disposed || this.selectedTaskId !== task.id) return;
			this.tailCache = {
				taskId: task.id,
				lines: [],
				totalBytes: task.outputBytes,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.tickBusy = false;
		}
	}

	private renderTaskRow(task: BgTask | undefined, selected: BgTask | undefined, width: number): string {
		if (!task) return " ".repeat(width);
		const isSelected = task === selected;
		const duration = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
		const command = firstCommandLine(task.command);
		if (isSelected) {
			const plain = `→ ${statusGlyph(task)} ${task.id} ${duration} ${command}`;
			const styled = this.theme.bg("selectedBg", this.theme.fg("text", plain));
			return padLine(styled, width);
		}
		const glyph = this.theme.fg("accent", statusGlyph(task));
		const id = this.theme.fg("accent", task.id);
		const muted = this.theme.fg("muted", `${duration} ${command}`);
		return padLine(`${glyph} ${id} ${muted}`, width);
	}

	private renderViewportRow(task: BgTask | undefined, row: number, width: number, bodyHeight: number): string {
		if (row === 0) {
			return padLine(this.viewportHeader(task), width);
		}
		const contentHeight = bodyHeight - 1;
		if (!task) return padLine("", width);
		const cache = this.tailCache;
		const error = cache && cache.taskId === task.id ? cache.error : undefined;
		if (error) {
			return row === 1
				? padLine(this.theme.fg("error", truncateToWidth(`Cannot read output: ${error}`, width)), width)
				: padLine("", width);
		}
		const lines = cache && cache.taskId === task.id ? cache.lines : [];
		const fromEnd = this.follow ? 0 : this.tailOffsetLines;
		const index = lines.length - contentHeight - fromEnd + (row - 1);
		const line = lines[index];
		if (line === undefined) return padLine("", width);
		return padLine(this.theme.fg("toolOutput", line), width);
	}

	private viewportHeader(task: BgTask | undefined): string {
		if (!task) return this.theme.fg("muted", "(no task selected)");
		const duration = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
		const exit = task.exitCode !== undefined && task.exitCode !== null ? ` exit ${task.exitCode}` : "";
		const paused = this.follow ? "" : " — paused (PgDn to follow)";
		const fileName = task.outputPath.replace(/\\/g, "/").split("/").at(-1) ?? task.outputPath;
		const header = `${task.id} · ${task.status}${exit} · ${duration} · ${sizeLabel(task)} · ${fileName}${paused}`;
		if (this.killFeedback && this.selectedTask() === task) {
			return this.theme.fg("warning", truncateToWidth(this.killFeedback, 200));
		}
		return this.theme.fg("muted", truncateToWidth(header, 200));
	}

	private hintsLine(): string {
		const parts = [
			`${keyLabel("tui.select.up", { keybindings: this.keybindings })}/${keyLabel("tui.select.down", { keybindings: this.keybindings })} select`,
			`${keyLabel("app.backgroundTasks.kill", { keybindings: this.keybindings })} kill`,
			`${keyLabel("tui.select.pageUp", { keybindings: this.keybindings })}/${keyLabel("tui.select.pageDown", { keybindings: this.keybindings })} scroll`,
			`${keyLabel("tui.select.cancel", { keybindings: this.keybindings })} close`,
		].filter(Boolean);
		return this.theme.fg("dim", parts.join(" · "));
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
