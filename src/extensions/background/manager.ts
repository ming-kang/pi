/** Inline observer: selecting or closing a view never changes execution ownership. */
import { homedir } from "node:os";
import {
	type Component,
	type Focusable,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type BackgroundContext,
	type BackgroundTask,
	type BackgroundWorker,
	isBackgroundTerminal,
	isForegroundShellTask,
} from "../../core/background/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { STATUS_SPINNER_INTERVAL_MS, statusMarker } from "../../modes/interactive/components/status-marker.ts";
import { getMarkdownTheme, highlightCode, type Theme, type ThemeColor } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { exitSuffix, runtimeLabel, taskLabel, workerLabel } from "./task-view.ts";
import { firstCommandLine, formatAge } from "./text.ts";

export type BackgroundManagerHost = Pick<BackgroundContext, "list" | "read" | "kill" | "subscribe" | "pin">;
export interface BackgroundTasksMenuOptions {
	tui: { requestRender(): void; terminal: { rows: number; columns: number } };
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	host: BackgroundManagerHost;
	onClose(): void;
	pollIntervalMs?: number;
}
interface Row {
	key: string;
	task: BackgroundTask;
	worker?: BackgroundWorker;
}
type ListItem = { header: string } | { row: Row };
interface PreviewPosition {
	scroll: number;
	follow: boolean;
	anchor?: { line: number; column: number };
	output?: { text: string; readError?: string; settled: boolean };
}
interface WrappedEntry {
	text: string;
	line: number;
	column: number;
}
interface Layout {
	wide: boolean;
	listWidth: number;
	previewWidth: number;
	bodyHeight: number;
	visibleItems: ListItem[];
	listVisible: number;
	detail: string[];
	content: string[];
	contentHeight: number;
	start: number;
	max: number;
	total: number;
	entries: WrappedEntry[];
}
const WIDE_MIN_WIDTH = 100;
const LIST_MIN_WIDTH = 28;
const LIST_MAX_WIDTH = 44;
const NARROW_LIST_MAX_ROWS = 7;
/** Below this the two-pane layout is unreadable; show a resize notice instead. */
const MIN_RENDER_WIDTH = 60;
const MIN_RENDER_HEIGHT = 12;
/** A pending kill confirmation auto-cancels instead of capturing input forever. */
const KILL_CONFIRM_TIMEOUT_MS = 5000;
const DETAIL_LABEL_WIDTH = 10;
const DETAIL_MAX_ROWS = 9;
const COMMAND_MAX_ROWS = 3;
const ERROR_MAX_ROWS = 2;
/** Long field values (worker model/usage) wrap up to this many rows instead of truncating. */
const DETAIL_VALUE_MAX_ROWS = 2;
const RENDER_CACHE_MAX = 8;
const clean = (text: string) => sanitizeBinaryOutput(stripTerminalSequences(text));
const pad = (text: string, width: number) => truncateToWidth(text, width, "…", true);
const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ");

function headChars(text: string, width: number): string {
	let out = "";
	let used = 0;
	for (const char of text) {
		const charWidth = visibleWidth(char);
		if (used + charWidth > width) break;
		out += char;
		used += charWidth;
	}
	return out;
}
function tailChars(text: string, width: number): string {
	let out = "";
	let used = 0;
	const chars = [...text];
	for (let i = chars.length - 1; i >= 0; i--) {
		const charWidth = visibleWidth(chars[i]!);
		if (used + charWidth > width) break;
		out = chars[i] + out;
		used += charWidth;
	}
	return out;
}
function ellipsizeMiddle(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return truncateToWidth(text, Math.max(1, width), "…");
	const head = Math.ceil((width - 1) / 2);
	const tail = width - 1 - head;
	return `${headChars(text, head)}…${tailChars(text, tail)}`;
}
function displayPath(path: string, width: number): string {
	const home = homedir();
	const shortened = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	return ellipsizeMiddle(shortened, width);
}

export class BackgroundTasksMenu implements Component, Focusable {
	focused = false;
	private readonly options: BackgroundTasksMenuOptions;
	private rows: Row[] = [];
	private runningCount = 0;
	private finishedCount = 0;
	private completedCount = 0;
	private failedCount = 0;
	private hiddenFinished = 0;
	private selected?: string;
	private pinned?: string;
	private releasePin?: () => void;
	private unsubscribe: () => void;
	private pollTimer: ReturnType<typeof setInterval>;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private focus: "list" | "preview" = "list";
	private pendingKill?: string;
	private pendingKillTimer?: ReturnType<typeof setTimeout>;
	private readonly positions = new Map<string, PreviewPosition>();
	private readonly renderCache = new Map<string, string[]>();
	private width: number;
	private busy = false;
	private feedback?: string;
	private lastFrame = "";

	constructor(options: BackgroundTasksMenuOptions) {
		this.options = options;
		this.width = options.tui.terminal.columns;
		this.sync();
		this.unsubscribe = options.host.subscribe(() => {
			this.sync();
			// Coalesce high-frequency progress; polling reads only visible output.
		});
		this.pollTimer = setInterval(() => this.queueTick(), options.pollIntervalMs ?? 1000);
		this.pollTimer.unref?.();
		this.queueTick();
	}
	private queueTick(): void {
		void this.tick().catch(() => {
			/* A failed repaint must not become an unhandled rejection. */
		});
	}
	invalidate(): void {
		this.lastFrame = "";
		this.renderCache.clear();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.pollTimer);
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.clearPendingKill();
		this.unsubscribe();
		this.releasePin?.();
		this.positions.clear();
	}
	private clearPendingKill(): void {
		this.pendingKill = undefined;
		if (this.pendingKillTimer) {
			clearTimeout(this.pendingKillTimer);
			this.pendingKillTimer = undefined;
		}
	}
	private current(): Row | undefined {
		return this.rows.find((row) => row.key === this.selected);
	}
	private wide(): boolean {
		return this.width >= WIDE_MIN_WIDTH;
	}
	/** Fullscreen overlay: body fills the terminal minus the frame (rule, title, rule, hints, rule). */
	private bodyHeight(): number {
		return Math.max(6, this.options.tui.terminal.rows - 5);
	}
	private sync(): void {
		if (this.disposed) return;
		const tasks = this.options.host.list();
		const running = tasks
			.filter((task) => !isBackgroundTerminal(task.status))
			.sort((a, b) => b.startedAt - a.startedAt);
		// Finished includes every subagent group and background shell. Foreground
		// shells deliver inline, except the selected row stays until selection moves.
		const selectedTask = this.selected?.split("/")[0];
		const settled = tasks
			.filter((task) => isBackgroundTerminal(task.status))
			.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		const finished = settled.filter((task) => !isForegroundShellTask(task) || task.id === selectedTask);
		this.runningCount = running.length;
		this.finishedCount = finished.length;
		this.completedCount = finished.filter((task) => task.status === "completed").length;
		this.failedCount = this.finishedCount - this.completedCount;
		this.hiddenFinished = settled.length - finished.length;
		this.rows = [...running, ...finished].flatMap((task): Row[] => [
			{ key: task.id, task },
			...(task.projection?.workers ?? []).map((worker) => ({ key: `${task.id}/${worker.id}`, task, worker })),
		]);
		if (!this.current()) {
			this.selected = this.rows[0]?.key;
		}
		const keys = new Set(this.rows.map((row) => row.key));
		for (const key of this.positions.keys()) if (!keys.has(key)) this.positions.delete(key);
		const id = this.current()?.task.id;
		if (id !== this.pinned) {
			// Acquire before releasing so history eviction cannot steal the selection.
			const release = id ? this.options.host.pin(id) : undefined;
			const previous = this.releasePin;
			this.pinned = id;
			this.releasePin = release;
			previous?.();
		}
		// Spinner frames must advance independently of output polling and pending reads.
		if (this.rows.some((row) => (row.worker?.status ?? row.task.status) === "running")) {
			if (!this.animationTimer) {
				this.animationTimer = setInterval(() => this.options.tui.requestRender(), STATUS_SPINNER_INTERVAL_MS);
				this.animationTimer.unref?.();
			}
		} else {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}
	private async tick(): Promise<void> {
		if (this.disposed) return;
		this.sync();
		if (this.wide() || this.focus === "preview") await this.refresh();
		if (this.disposed) return;
		const frame = this.render(this.width).join("\n");
		if (frame !== this.lastFrame) {
			this.lastFrame = frame;
			this.options.tui.requestRender();
		}
	}
	private async refresh(): Promise<void> {
		const row = this.current();
		if (!row || row.worker || row.task.kind !== "bash" || this.busy) return;
		const position = this.position();
		// Keep the bounded output with its row's scroll anchor while browsing.
		// A new tail can otherwise move even lines that are still inside the read window.
		if (position.output && (!position.follow || position.output.settled)) return;
		this.busy = true;
		try {
			const slice = await this.options.host.read(row.task.id, { mode: "tail", bytes: 128 * 1024 });
			if (this.disposed || this.selected !== row.key) return;
			// A read started while following may settle after the user scrolls up.
			if (!position.follow && position.output) return;
			position.output = {
				text: clean(slice.text).split("\n").slice(-2000).join("\n"),
				readError: slice.readError ? clean(slice.readError).slice(0, 4096) : undefined,
				settled: isBackgroundTerminal(slice.task.status),
			};
		} catch (error) {
			if (!this.disposed && this.selected === row.key && (position.follow || !position.output)) {
				position.output = {
					text: "",
					readError: `Cannot read output: ${clean(String(error)).slice(0, 1000)}`,
					settled: false,
				};
			}
		} finally {
			this.busy = false;
		}
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		this.feedback = undefined;
		if (this.pendingKill) {
			// The one raw-key exception: a pending y/N confirmation captures the next input.
			const id = this.pendingKill;
			this.clearPendingKill();
			if (data === "y" || data === "Y") {
				try {
					this.feedback = this.options.host.kill(id)
						? `stopping ${id}… (whole group)`
						: `${id}: no new cancellation requested`;
				} catch (error) {
					this.feedback = oneLine(String(error));
				}
			}
			this.options.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.focus === "preview") this.focus = "list";
			else {
				this.dispose();
				this.options.onClose();
				return;
			}
		} else if (kb.matches(data, "app.backgroundTasks.kill")) {
			const row = this.current();
			if (row) {
				this.clearPendingKill();
				this.pendingKill = row.task.id;
				this.pendingKillTimer = setTimeout(() => {
					this.pendingKill = undefined;
					this.pendingKillTimer = undefined;
					if (!this.disposed) this.options.tui.requestRender();
				}, KILL_CONFIRM_TIMEOUT_MS);
				this.pendingKillTimer.unref?.();
			}
		} else if (kb.matches(data, "app.backgroundTasks.focusList")) {
			this.focus = "list";
		} else if (kb.matches(data, "app.backgroundTasks.focusPreview") || kb.matches(data, "tui.select.confirm")) {
			this.focus = "preview";
			this.queueTick();
		} else {
			const pageUp = kb.matches(data, this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp");
			const pageDown = kb.matches(data, this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown");
			const direction =
				pageUp || kb.matches(data, "tui.select.up") ? -1 : pageDown || kb.matches(data, "tui.select.down") ? 1 : 0;
			const layout = this.layout();
			const delta =
				direction *
				(pageUp || pageDown ? (this.focus === "preview" ? layout.contentHeight : layout.listVisible) : 1);
			if (delta && this.focus === "preview") this.scrollPreview(delta);
			else if (delta && this.rows.length) {
				const index = this.rows.findIndex((row) => row.key === this.selected);
				const next =
					pageUp || pageDown
						? Math.max(0, Math.min(this.rows.length - 1, index + delta))
						: (index + delta + this.rows.length) % this.rows.length;
				this.selected = this.rows[next]?.key;
				this.sync();
				this.queueTick();
			}
		}
		this.options.tui.requestRender();
	}
	private position(): PreviewPosition {
		const key = this.selected ?? "";
		let position = this.positions.get(key);
		if (!position) {
			position = { scroll: 0, follow: this.current()?.task.kind === "bash" && !this.current()?.worker };
			if (this.selected) this.positions.set(key, position);
		}
		return position;
	}
	/** Selectable rows interleaved with their section headers; headers are display-only and never selected. */
	private listItems(): ListItem[] {
		const items: ListItem[] = [];
		let section = "";
		for (const row of this.rows) {
			const next = isBackgroundTerminal(row.task.status) ? "Finished" : "Running";
			if (next !== section) {
				section = next;
				items.push({ header: next });
			}
			items.push({ row });
		}
		return items;
	}
	private cacheSet(key: string, lines: string[]): void {
		if (this.renderCache.size >= RENDER_CACHE_MAX) {
			const oldest = this.renderCache.keys().next().value;
			if (oldest !== undefined) this.renderCache.delete(oldest);
		}
		this.renderCache.set(key, lines);
	}
	private commandLines(task: BackgroundTask, width: number, maxRows: number): string[] {
		const first = firstCommandLine(task.command ?? "");
		const key = `command|${task.id}|${width}|${first.length}`;
		let lines = this.renderCache.get(key);
		if (!lines) {
			lines = wrapTextWithAnsi(highlightCode(first, "bash")[0] ?? "", Math.max(1, width));
			this.cacheSet(key, lines);
		}
		return lines.slice(0, maxRows);
	}
	private markdownLines(rowKey: string, section: string, text: string, width: number): string[] {
		const key = `${section}|${rowKey}|${width}|${text.length}`;
		const cached = this.renderCache.get(key);
		if (cached) return cached;
		const lines = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => this.options.theme.fg("toolOutput", value),
		}).render(Math.max(1, width));
		this.cacheSet(key, lines);
		return lines;
	}
	private detailLines(row: Row | undefined, valueWidth: number, compact: boolean): string[] {
		if (!row) return [];
		const { theme } = this.options;
		const { task, worker } = row;
		const now = Date.now();
		const marker = statusMarker(worker?.status ?? task.status, { now });
		const glyph = theme.fg(marker.color, marker.glyph);
		const time =
			isBackgroundTerminal(task.status) && task.endedAt ? formatAge(task.endedAt, now) : runtimeLabel(task, now);
		const field = (label: string, values: string[]): string[] =>
			values.map(
				(value, index) => `${theme.fg("dim", padEnd(index === 0 ? label : "", DETAIL_LABEL_WIDTH))}${value}`,
			);
		const status = worker
			? `${glyph} ${worker.status}`
			: `${glyph} ${task.status} · ${task.mode} · ${time}${exitSuffix(task.exitCode, " · ")}`;
		if (compact) {
			const second = worker
				? field("Worker", [truncateToWidth(clean(worker.label), valueWidth, "…")])
				: task.command
					? field("Command", this.commandLines(task, valueWidth, 1))
					: field("Task", [truncateToWidth(task.id, valueWidth, "…")]);
			return [...field("Status", [status]), ...second];
		}
		if (worker) {
			// Model and usage get their own rows and wrap rather than truncate:
			// one combined line always overflows at realistic widths.
			const wrap = (value: string) =>
				wrapTextWithAnsi(value, Math.max(1, valueWidth)).slice(0, DETAIL_VALUE_MAX_ROWS);
			return [
				...field("Status", [status]),
				...field("Worker", [truncateToWidth(clean(worker.label), valueWidth, "…")]),
				...field("Group", [truncateToWidth(task.id, valueWidth, "…")]),
				...field("Model", wrap(worker.model ?? "—")),
				...field("Usage", wrap(worker.usage ?? "—")),
			];
		}
		const readError = this.positions.get(row.key)?.output?.readError;
		const lines = [
			...field("Status", [status]),
			...field("Task", [truncateToWidth(task.id, valueWidth, "…")]),
			...field(
				"Error",
				[
					task.error ? `Task error: ${oneLine(task.error)}` : "",
					readError ? `Output read error: ${oneLine(readError)}` : "",
				]
					.filter(Boolean)
					.flatMap((error) => wrapTextWithAnsi(theme.fg("error", error), Math.max(1, valueWidth)))
					.slice(0, ERROR_MAX_ROWS),
			),
		];
		if (task.kind === "bash") {
			if (task.command) lines.push(...field("Command", this.commandLines(task, valueWidth, COMMAND_MAX_ROWS)));
			if (task.cwd)
				lines.push(...field("Directory", [truncateToWidth(displayPath(task.cwd, valueWidth), valueWidth, "…")]));
			if (task.outputPath) lines.push(...field("Output", [displayPath(task.outputPath, valueWidth)]));
		}
		return lines.slice(0, DETAIL_MAX_ROWS);
	}
	private workerLines(row: Row, width: number): string[] {
		const worker = row.worker;
		if (!worker) return [];
		const { theme } = this.options;
		const heading = (text: string) => theme.fg("dim", theme.bold(text));
		const lines = [
			heading("Prompt"),
			...this.markdownLines(row.key, "prompt", worker.prompt, width),
			"",
			heading("Activity"),
		];
		for (const line of worker.activity ? clean(worker.activity).split("\n") : ["—"])
			lines.push(theme.fg("toolOutput", line));
		lines.push("");
		if (worker.error)
			lines.push(
				...wrapTextWithAnsi(theme.fg("error", oneLine(worker.error)), Math.max(1, width)).slice(0, ERROR_MAX_ROWS),
			);
		lines.push(heading("Outcome"));
		if (worker.report.text) lines.push(...this.markdownLines(row.key, "outcome", worker.report.text, width));
		else if (worker.status === "queued" || worker.status === "running")
			lines.push(theme.fg("muted", "Still running…"));
		else lines.push(theme.fg("muted", "No report returned."));
		if (worker.report.truncated) lines.push(theme.fg("warning", "[Saved report truncated.]"));
		return lines;
	}
	private contentLines(row: Row | undefined, width: number): string[] {
		if (!row) return [];
		const { theme } = this.options;
		const { task, worker } = row;
		if (worker) return this.workerLines(row, width);
		if (task.kind !== "bash") {
			const workers = task.projection?.workers ?? [];
			const now = Date.now();
			if (workers.length)
				return workers.map((w) => {
					const marker = statusMarker(w.status, { now });
					// One truncated line per worker — an index of who did what. Model
					// and usage live in the worker's own detail view.
					const summary = oneLine(`${w.label} · ${w.status}${w.description ? ` — ${w.description}` : ""}`);
					return `${theme.fg(marker.color, marker.glyph)} ${theme.fg("toolOutput", truncateToWidth(summary, Math.max(1, width), "…"))}`;
				});
			const fallback = task.projection?.text;
			return fallback
				? clean(fallback)
						.split("\n")
						.map((line) => theme.fg("toolOutput", line))
				: [theme.fg("muted", "No workers.")];
		}
		const text = this.positions.get(row.key)?.output?.text ?? task.projection?.text ?? "Loading…";
		return clean(text)
			.split("\n")
			.map((line) => theme.fg("toolOutput", line));
	}
	/** One geometry calculation shared by rendering and page/line navigation. */
	private layout(): Layout {
		const wide = this.wide();
		const listWidth = wide
			? Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.floor((this.width - 1) * 0.36)))
			: this.width;
		const previewWidth = wide ? this.width - listWidth - 1 : this.width;
		const bodyHeight = this.bodyHeight();
		const items = this.listItems();
		const selectedIndex = items.findIndex((item) => "row" in item && item.row.key === this.selected);
		const listVisible = wide ? bodyHeight : Math.min(NARROW_LIST_MAX_ROWS, Math.max(1, bodyHeight - 4));
		const listFirst = Math.max(0, selectedIndex - listVisible + 1);
		const visibleItems = items.slice(listFirst, listFirst + listVisible);
		const row = this.current();
		const detail = this.detailLines(row, Math.max(1, previewWidth - DETAIL_LABEL_WIDTH), !wide).slice(
			0,
			wide ? Math.max(1, Math.min(DETAIL_MAX_ROWS, bodyHeight - 2)) : 2,
		);
		const contentHeight = wide
			? Math.max(1, bodyHeight - detail.length - 1)
			: Math.max(1, bodyHeight - visibleItems.length - detail.length - 1);
		const wrapped = this.contentLines(row, previewWidth).flatMap((line, lineIndex) => {
			let column = 0;
			return wrapTextWithAnsi(line, Math.max(1, previewWidth)).map((text) => {
				const entry = { text, line: lineIndex, column };
				column += visibleWidth(text);
				return entry;
			});
		});
		const entries = row?.task.kind === "bash" && !row.worker ? wrapped.slice(-2000) : wrapped.slice(0, 2000);
		const content = entries.map((entry) => entry.text);
		const max = Math.max(0, content.length - contentHeight);
		const position = this.position();
		let offset = position.scroll;
		if (position.anchor) {
			const anchor = position.anchor;
			const first = entries.findIndex((entry) => entry.line === anchor.line);
			if (first >= 0) {
				offset = first;
				while (
					offset + 1 < entries.length &&
					entries[offset + 1]!.line === anchor.line &&
					entries[offset + 1]!.column <= anchor.column
				)
					offset++;
			}
		}
		const start = position.follow ? max : Math.min(offset, max);
		return {
			wide,
			listWidth,
			previewWidth,
			bodyHeight,
			visibleItems,
			listVisible,
			detail,
			content,
			contentHeight,
			start,
			max,
			total: content.length,
			entries,
		};
	}
	private scrollPreview(delta: number): void {
		const { start, max, entries } = this.layout();
		const position = this.position();
		const wasFollowing = position.follow;
		position.scroll = Math.min(max, Math.max(0, start + delta));
		const entry = entries[position.scroll];
		position.anchor = entry ? { line: entry.line, column: entry.column } : undefined;
		// Only an explicit downward movement resumes shell following, never resize/update.
		position.follow =
			delta > 0 && position.scroll === max && this.current()?.task.kind === "bash" && !this.current()?.worker;
		if (position.follow && !wasFollowing) this.queueTick();
	}
	private listRowLine(row: Row, width: number): string {
		const { theme } = this.options;
		const selected = row.key === this.selected;
		const now = Date.now();
		const marker = statusMarker(row.worker?.status ?? row.task.status, { now });
		const glyph = theme.fg(marker.color, marker.glyph);
		const cursor = selected ? theme.fg(this.focus === "list" ? "accent" : "muted", "→ ") : "  ";
		const indent = row.worker ? "  " : "";
		const terminal = isBackgroundTerminal(row.task.status);
		// Foreground mode stays explicit, including completed subagent groups.
		let time = "";
		if (!row.worker) {
			time = terminal ? formatAge(row.task.endedAt ?? row.task.startedAt, now) : runtimeLabel(row.task, now);
			const workers = row.task.projection?.workers;
			if (workers && workers.length > 0) {
				const settledCount = workers.filter((w) => w.status !== "queued" && w.status !== "running").length;
				time = `${settledCount}/${workers.length} · ${time}`;
			}
			if (row.task.mode === "foreground") time = `fg · ${time}`;
		}
		const timeWidth = time ? visibleWidth(time) + 1 : 0;
		const labelWidth = Math.max(1, width - 2 - indent.length - visibleWidth(glyph) - 1 - timeWidth);
		const labelColor: ThemeColor = selected && this.focus === "list" ? "accent" : "text";
		const label = theme.fg(
			labelColor,
			truncateToWidth(
				clean(row.worker ? workerLabel(row.worker) : taskLabel({ command: row.task.command ?? row.task.title })),
				labelWidth,
				"…",
			),
		);
		let line = `${cursor}${indent}${glyph} ${label}`;
		if (time)
			line += " ".repeat(Math.max(1, width - visibleWidth(line) - visibleWidth(time))) + theme.fg("dim", time);
		return pad(line, width);
	}
	private emptyLine(width: number): string {
		return this.centered(width, "No background tasks.");
	}
	/** Tiny-terminal fallback: the frame stays, the layout steps aside. */
	private renderTooSmall(width: number, rows: number): string[] {
		const { theme, keybindings } = this.options;
		const rule = () => new DynamicBorder((text) => theme.fg("border", text)).render(width)[0] ?? "";
		const message = `Terminal too small for /bg — resize to at least ${MIN_RENDER_WIDTH}×${MIN_RENDER_HEIGHT}.`;
		const bodyHeight = Math.max(1, rows - 4);
		const body = Array.from({ length: bodyHeight }, () => pad("", width));
		body[Math.floor(bodyHeight / 2)] = this.centered(width, message);
		const closeHint = pad(theme.fg("dim", `${keyLabel("tui.select.cancel", { keybindings })} close`), width);
		return [rule(), ...body, rule(), closeHint, rule()];
	}
	private centered(width: number, message: string): string {
		const leftPad = Math.max(0, Math.floor((width - visibleWidth(message)) / 2));
		return pad(this.options.theme.fg("muted", `${" ".repeat(leftPad)}${message}`), width);
	}
	private dividerLine(layout: Layout): string {
		const { theme } = this.options;
		const row = this.current();
		const label = row ? (row.worker ? "Worker" : row.task.kind === "bash" ? "Output" : "Workers") : "Output";
		const styledLabel = theme.fg(this.focus === "preview" ? "accent" : "muted", label);
		const shell = row !== undefined && row.task.kind === "bash" && !row.worker;
		const suffix = shell ? theme.fg("muted", ` · tail · ${this.position().follow ? "following" : "browsing"}`) : "";
		const range = theme.fg(
			"muted",
			`${layout.total ? layout.start + 1 : 0}–${Math.min(layout.start + layout.contentHeight, layout.total)}/${layout.total}`,
		);
		const rule = (count: number) => theme.fg("borderMuted", "─".repeat(Math.max(0, count)));
		const left = `${rule(1)} ${styledLabel}${suffix} `;
		const right = ` ${range} ${rule(1)}`;
		const fill = layout.previewWidth - visibleWidth(left) - visibleWidth(right);
		return pad(`${left}${rule(fill)}${right}`, layout.previewWidth);
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const terminalRows = this.options.tui.terminal.rows;
		if (width < MIN_RENDER_WIDTH || terminalRows < MIN_RENDER_HEIGHT) {
			return this.renderTooSmall(width, terminalRows);
		}
		const wasWide = this.wide();
		this.width = width;
		if (!wasWide && this.wide()) this.queueTick();
		const { theme, keybindings } = this.options;
		const layout = this.layout();
		const rule = () => new DynamicBorder((text) => theme.fg("border", text)).render(width)[0] ?? "";
		const title = theme.fg("accent", theme.bold("Background tasks"));
		// Only non-zero segments show: a quiet header means nothing needs attention.
		const segments: string[] = [];
		if (this.runningCount > 0) segments.push(theme.fg("accent", `${this.runningCount} running`));
		if (this.completedCount > 0) segments.push(theme.fg("muted", `${this.completedCount} completed`));
		if (this.failedCount > 0) segments.push(theme.fg("error", `${this.failedCount} failed`));
		if (this.hiddenFinished > 0)
			segments.push(
				theme.fg("muted", `${this.hiddenFinished} foreground shell${this.hiddenFinished === 1 ? "" : "s"} hidden`),
			);
		const stats = segments.join(theme.fg("muted", " · "));
		const gap = width - visibleWidth(title) - visibleWidth(stats);
		const titleLine = pad(stats && gap >= 1 ? `${title}${" ".repeat(gap)}${stats}` : title, width);
		const hint = (id: Parameters<typeof keybindings.getKeys>[0]) => keyLabel(id, { keybindings });
		const pageUp = this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp";
		const pageDown = this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown";
		const hints = [
			`${hint("tui.select.up")}/${hint("tui.select.down")} select`,
			`${hint("app.backgroundTasks.focusList")} list`,
			`${hint("app.backgroundTasks.focusPreview")}/${hint("tui.select.confirm")} output`,
			`${hint(pageUp)}/${hint(pageDown)} page`,
			`${hint("app.backgroundTasks.kill")} stop`,
			`${hint("tui.select.cancel")} close`,
		].join(" · ");
		const hintLine = pad(
			this.pendingKill
				? theme.fg("warning", `Stop ${this.pendingKill} (whole group)? y/N`)
				: theme.fg(this.feedback ? "muted" : "dim", this.feedback ?? hints),
			width,
		);
		const leftLines = layout.visibleItems.length
			? layout.visibleItems.map((item) =>
					"header" in item
						? pad(theme.fg("dim", item.header), layout.listWidth)
						: this.listRowLine(item.row, layout.listWidth),
				)
			: [this.emptyLine(layout.listWidth)];
		const contentWindow = layout.content.slice(layout.start, layout.start + layout.contentHeight);
		const divider = this.dividerLine(layout);
		const body: string[] = [];
		if (layout.wide) {
			const right = [...layout.detail, divider, ...contentWindow];
			for (let i = 0; i < layout.bodyHeight; i++)
				body.push(
					pad(
						`${pad(leftLines[i] ?? "", layout.listWidth)}${theme.fg("borderMuted", "│")}${pad(right[i] ?? "", layout.previewWidth)}`,
						width,
					),
				);
		} else {
			body.push(...[...leftLines, ...layout.detail, divider, ...contentWindow].map((line) => pad(line, width)));
			while (body.length < layout.bodyHeight) body.push(pad("", width));
		}
		return [rule(), titleLine, ...body.slice(0, layout.bodyHeight), rule(), hintLine, rule()].map((line) =>
			pad(line, width),
		);
	}
}
