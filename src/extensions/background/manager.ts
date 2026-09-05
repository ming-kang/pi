/** Inline observer: selecting or closing a view never changes execution ownership. */
import {
	type Component,
	type Focusable,
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
} from "../../core/background/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { runtimeLabel, statusColor, statusGlyph } from "./task-view.ts";

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
interface PreviewPosition {
	scroll: number;
	follow: boolean;
	anchor?: { line: number; column: number };
}
const clean = (text: string) => sanitizeBinaryOutput(stripTerminalSequences(text));
const pad = (text: string, width: number) => truncateToWidth(text, width, "…", true);

export class BackgroundTasksMenu implements Component, Focusable {
	focused = false;
	private readonly options: BackgroundTasksMenuOptions;
	private rows: Row[] = [];
	private selected?: string;
	private pinned?: string;
	private releasePin?: () => void;
	private unsubscribe: () => void;
	private timer: ReturnType<typeof setInterval>;
	private disposed = false;
	private focus: "list" | "preview" = "list";
	private readonly positions = new Map<string, PreviewPosition>();
	private width: number;
	private text = "";
	private readKey?: string;
	private readError?: string;
	private finalRead = false;
	private busy = false;
	private feedback?: string;
	private lastFrame = "";

	constructor(options: BackgroundTasksMenuOptions) {
		this.options = options;
		this.width = options.tui.terminal.columns;
		this.sync();
		this.unsubscribe = options.host.subscribe(() => {
			this.sync();
			// Coalesce high-frequency progress; the timer reads only visible output.
		});
		this.timer = setInterval(() => void this.tick(), options.pollIntervalMs ?? 1000);
		this.timer.unref?.();
		void this.tick();
	}
	invalidate(): void {
		this.lastFrame = "";
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		this.unsubscribe();
		this.releasePin?.();
	}
	private current(): Row | undefined {
		return this.rows.find((row) => row.key === this.selected);
	}
	private wide(): boolean {
		return this.width >= 110;
	}
	private height(): number {
		return Math.min(20, Math.max(10, this.options.tui.terminal.rows - 8));
	}
	private sync(): void {
		if (this.disposed) return;
		this.rows = this.options.host
			.list()
			.flatMap((task): Row[] => [
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
		if (!row || row.worker || this.busy || (this.readKey === row.key && this.finalRead)) return;
		this.busy = true;
		try {
			const slice = await this.options.host.read(row.task.id, { mode: "tail", bytes: 128 * 1024 });
			if (this.disposed || this.selected !== row.key) return;
			this.text = clean(slice.text).split("\n").slice(-2000).join("\n");
			this.readKey = row.key;
			this.readError = slice.readError ? clean(slice.readError).slice(0, 4096) : undefined;
			this.finalRead = isBackgroundTerminal(slice.task.status);
		} catch (error) {
			if (!this.disposed && this.selected === row.key) {
				this.text = "";
				this.readError = `Cannot read output: ${clean(String(error)).slice(0, 1000)}`;
				this.readKey = row.key;
			}
		} finally {
			this.busy = false;
		}
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		this.feedback = undefined;
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
				try {
					this.feedback = this.options.host.kill(row.task.id)
						? `stopping ${row.task.id}… (whole group)`
						: `${row.task.id}: no new cancellation requested`;
				} catch (error) {
					this.feedback = clean(String(error)).replace(/\s+/g, " ");
				}
			}
		} else if (kb.matches(data, "app.backgroundTasks.focusList")) {
			this.focus = "list";
		} else if (kb.matches(data, "app.backgroundTasks.focusPreview") || kb.matches(data, "tui.select.confirm")) {
			this.focus = "preview";
			void this.tick();
		} else {
			const pageUp = kb.matches(data, this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp");
			const pageDown = kb.matches(data, this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown");
			const direction =
				pageUp || kb.matches(data, "tui.select.up") ? -1 : pageDown || kb.matches(data, "tui.select.down") ? 1 : 0;
			const layout = this.layout();
			const delta =
				direction *
				(pageUp || pageDown ? (this.focus === "preview" ? layout.contentHeight : layout.bodyHeight) : 1);
			if (delta && this.focus === "preview") this.scrollPreview(delta);
			else if (delta && this.rows.length) {
				const index = this.rows.findIndex((row) => row.key === this.selected);
				const next =
					pageUp || pageDown
						? Math.max(0, Math.min(this.rows.length - 1, index + delta))
						: (index + delta + this.rows.length) % this.rows.length;
				this.selected = this.rows[next]?.key;
				this.text = "";
				this.readKey = undefined;
				this.readError = undefined;
				this.finalRead = false;
				this.sync();
				void this.tick();
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
	private diagnostics(): string[] {
		const row = this.current();
		if (!row) return [];
		return [
			row.task.error ? `Task error: ${row.task.error}` : "",
			!row.worker && this.readKey === row.key && this.readError ? `Output read error: ${this.readError}` : "",
		].filter(Boolean);
	}
	/** One geometry calculation shared by rendering and page/line navigation. */
	private layout() {
		const innerWidth = Math.max(0, this.width - 2);
		const listWidth = this.wide() ? Math.floor(innerWidth * 0.4) : innerWidth;
		const previewWidth = this.wide() ? innerWidth - listWidth - 1 : innerWidth;
		// Borders, pane titles, range, and two hint rows are outside the pane body.
		const bodyHeight = this.height() - 6;
		const row = this.current();
		const metadata: string[] = [];
		let text = "No managed executions.";
		if (row) {
			const { task, worker } = row;
			metadata.push(
				worker
					? `${worker.label} · ${worker.status} · group ${task.id}`
					: `${task.status} · ${task.mode} · ${runtimeLabel(task)} · ${task.id}`,
			);
			metadata.push(...this.diagnostics());
			if (worker) {
				metadata.push(`Model: ${worker.model ?? "—"} · Usage: ${worker.usage ?? "—"}`);
				text = [
					"Prompt",
					worker.prompt,
					"",
					"Activity",
					worker.activity || "—",
					"",
					"Outcome",
					worker.outcome || "Still running…",
				].join("\n");
			} else {
				metadata.push(task.command ?? task.title);
				if (task.cwd) metadata.push(`cwd: ${task.cwd}`);
				if (task.outputPath) metadata.push(`Output: ${task.outputPath}`);
				text = this.readKey === row.key ? this.text : (task.projection?.text ?? "Loading…");
			}
		}
		// On very short terminals prioritize status and diagnostics, leaving one output row.
		const header = metadata.slice(0, bodyHeight - 1).map((line) => clean(line).replace(/\s+/g, " "));
		const wrapped = clean(text)
			.split("\n")
			.flatMap((line, lineIndex) => {
				let column = 0;
				return wrapTextWithAnsi(line, Math.max(1, previewWidth)).map((text) => {
					const entry = { text, line: lineIndex, column };
					column += visibleWidth(text);
					return entry;
				});
			});
		const entries = row?.task.kind === "bash" && !row.worker ? wrapped.slice(-2000) : wrapped.slice(0, 2000);
		const content = entries.map((entry) => entry.text);
		const contentHeight = bodyHeight - header.length;
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
		return { innerWidth, listWidth, previewWidth, bodyHeight, header, content, contentHeight, max, start, entries };
	}
	private scrollPreview(delta: number): void {
		const { start, max, entries } = this.layout();
		const position = this.position();
		position.scroll = Math.min(max, Math.max(0, start + delta));
		const entry = entries[position.scroll];
		position.anchor = entry ? { line: entry.line, column: entry.column } : undefined;
		// Only an explicit downward movement resumes shell following, never resize/update.
		position.follow =
			delta > 0 && position.scroll === max && this.current()?.task.kind === "bash" && !this.current()?.worker;
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const wasWide = this.wide();
		this.width = width;
		if (!wasWide && this.wide()) void this.tick();
		const { theme, keybindings } = this.options;
		const { innerWidth, listWidth, previewWidth, bodyHeight, header, content, contentHeight, start } = this.layout();
		const index = Math.max(
			0,
			this.rows.findIndex((row) => row.key === this.selected),
		);
		const first = Math.max(0, index - bodyHeight + 1);
		const list = this.rows.slice(first, first + bodyHeight).map((row) => {
			const status = row.worker?.status ?? row.task.status;
			const label = row.worker
				? `  ${row.worker.label} · ${status}`
				: `${statusGlyph(row.task.status)} ${row.task.id.slice(0, row.task.kind.length + 9)} · ${row.task.status} (${row.task.mode}) · ${row.task.title}`;
			const selected = row.key === this.selected;
			const text = pad(`${selected ? "→" : " "} ${clean(label)}`, listWidth);
			return selected
				? this.focus === "list"
					? theme.bg("selectedBg", theme.fg("accent", text))
					: theme.fg("muted", text)
				: theme.fg(statusColor(row.task.status), text);
		});
		if (!list.length) list.push(pad("No managed executions.", listWidth));
		const preview = [
			...header.map((line) => theme.fg("muted", line)),
			...content.slice(start, start + contentHeight).map((line) => theme.fg("toolOutput", line)),
		];
		const border = (text: string) => theme.fg("border", text);
		const frame = (text: string) => pad(border("│") + pad(text, innerWidth) + border("│"), width);
		const panes = (left: string, right: string) =>
			this.wide()
				? pad(left, listWidth) + border("│") + pad(right, previewWidth)
				: pad(this.focus === "list" ? left : right, innerWidth);
		const title = (pane: "list" | "preview", text: string) =>
			theme.fg(this.focus === pane ? "accent" : "muted", `${this.focus === pane ? "›" : " "} ${text}`);
		const range = (offset: number, count: number, total: number) =>
			`${total ? offset + 1 : 0}–${Math.min(offset + count, total)}/${total}`;
		const shell = this.current()?.task.kind === "bash" && !this.current()?.worker;
		const previewRange = `Lines ${range(start, contentHeight, content.length)}${shell ? (this.position().follow ? " · following" : " · browsing") : ""}`;
		const hint = (id: Parameters<typeof keybindings.getKeys>[0]) => keyLabel(id, { keybindings });
		return [
			pad(border(`╭${"─".repeat(innerWidth)}╮`), width),
			frame(
				panes(
					title("list", `Background tasks (${this.rows.length ? index + 1 : 0}/${this.rows.length})`),
					title("preview", "Preview"),
				),
			),
			...Array.from({ length: bodyHeight }, (_, i) => frame(panes(list[i] ?? "", preview[i] ?? ""))),
			frame(
				panes(
					theme.fg("muted", `Rows ${range(first, bodyHeight, this.rows.length)}`),
					theme.fg("muted", previewRange),
				),
			),
			frame(
				theme.fg(
					"muted",
					`${hint("app.backgroundTasks.focusList")} list · ${hint("app.backgroundTasks.focusPreview")}/${hint("tui.select.confirm")} preview · ${hint("tui.select.up")}/${hint("tui.select.down")} ${this.focus === "list" ? "select" : "scroll"} · ${hint(this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp")}/${hint(this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown")} page`,
				),
			),
			frame(
				theme.fg(
					"muted",
					this.feedback ??
						`${hint("tui.select.cancel")} ${this.focus === "preview" ? "back to list" : "close"} · ${hint("app.backgroundTasks.kill")} stop group`,
				),
			),
			pad(border(`╰${"─".repeat(innerWidth)}╯`), width),
		];
	}
}
