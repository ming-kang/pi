/** Inline observer: selecting or closing a view never changes execution ownership. */
import {
	type Component,
	type Focusable,
	stripTerminalSequences,
	truncateToWidth,
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
	private detail = false;
	private width: number;
	private scroll = 0;
	private follow = true;
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
		return Math.min(20, Math.max(4, this.options.tui.terminal.rows - 8));
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
			this.follow = !this.current()?.worker;
			this.scroll = 0;
		}
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
		if (this.wide() || this.detail) await this.refresh();
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
			if (this.detail) this.detail = false;
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
					this.feedback = clean(String(error));
				}
			}
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.detail = true;
			void this.tick();
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollDetail(-this.height());
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollDetail(this.height());
		} else {
			const delta = kb.matches(data, "tui.select.up") ? -1 : kb.matches(data, "tui.select.down") ? 1 : 0;
			if (delta && this.detail) this.scrollDetail(delta);
			else if (delta && this.rows.length) {
				const index = this.rows.findIndex((row) => row.key === this.selected);
				this.selected = this.rows[(index + delta + this.rows.length) % this.rows.length]?.key;
				this.scroll = 0;
				this.follow = !this.current()?.worker;
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
	private wrapDetail(text: string): string {
		const width = this.wide() ? this.width - Math.floor(this.width * 0.4) - 3 : this.width;
		return wrapTextWithAnsi(clean(text), Math.max(1, width)).slice(0, 2000).join("\n");
	}
	private detailLines(): string[] {
		const row = this.current();
		if (!row) return ["No managed executions."];
		const { task, worker } = row;
		if (worker)
			return clean(
				[
					`${worker.label} · ${worker.status} · group ${task.id}`,
					`Model: ${worker.model ?? "—"} · Usage: ${worker.usage ?? "—"}`,
					"",
					"Prompt",
					this.wrapDetail(worker.prompt),
					"",
					"Activity",
					this.wrapDetail(worker.activity || "—"),
					"",
					"Outcome",
					this.wrapDetail(worker.outcome || "Still running…"),
				].join("\n"),
			)
				.split("\n")
				.slice(0, 2000);
		return clean(
			[
				`${task.status} · ${task.mode} · ${runtimeLabel(task)} · ${task.id}`,
				this.wrapDetail(task.command ?? task.title),
				task.cwd ? this.wrapDetail(`cwd: ${task.cwd}`) : "",
				task.outputPath ? this.wrapDetail(`Output: ${task.outputPath}`) : "",
				...this.diagnostics().map((text) => this.wrapDetail(text)),
				this.readKey === row.key ? this.text : (task.projection?.text ?? "Loading…"),
			].join("\n"),
		).split("\n");
	}
	private diagnostics(): string[] {
		const row = this.current();
		if (!row || row.worker) return [];
		return [
			row.task.error ? `Task error: ${row.task.error}` : "",
			this.readKey === row.key && this.readError ? `Output read error: ${this.readError}` : "",
		].filter(Boolean);
	}
	private scrollDetail(delta: number): void {
		const max = Math.max(0, this.detailLines().length - this.height() + this.diagnostics().length);
		this.scroll = Math.min(max, Math.max(0, (this.follow ? max : this.scroll) + delta));
		this.follow = this.scroll === max && !this.current()?.worker;
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const wasWide = this.wide();
		this.width = width;
		if (!wasWide && this.wide()) void this.tick();
		const { theme, keybindings } = this.options;
		const height = this.height();
		const listWidth = this.wide() ? Math.floor(width * 0.4) : width;
		const detailWidth = this.wide() ? width - listWidth - 3 : width;
		const index = Math.max(
			0,
			this.rows.findIndex((row) => row.key === this.selected),
		);
		const first = Math.max(0, index - height + 1);
		const list = this.rows.slice(first, first + height).map((row) => {
			const status = row.worker?.status ?? row.task.status;
			const label = row.worker
				? `  ${row.worker.label} · ${status}`
				: `${statusGlyph(row.task.status)} ${row.task.id.slice(0, row.task.kind.length + 9)} · ${row.task.status} (${row.task.mode}) · ${row.task.title}`;
			const text = pad(`${row.key === this.selected ? "→" : " "} ${clean(label)}`, listWidth);
			return row.key === this.selected
				? theme.bg("selectedBg", theme.fg("text", text))
				: theme.fg(statusColor(row.task.status), text);
		});
		if (!list.length) list.push(pad("No managed executions.", listWidth));
		const [header = "", ...content] = this.detailLines();
		// Diagnostics stay visible even while following a long output tail. Their full
		// wrapped text also remains in the scrollable metadata above the raw log.
		const diagnostics = this.diagnostics().map((text) => clean(text).replace(/\s+/g, " "));
		const contentHeight = Math.max(1, height - 1 - diagnostics.length);
		const max = Math.max(0, content.length - contentHeight);
		const start = this.follow ? max : Math.min(this.scroll, max);
		const detail = [header, ...diagnostics, ...content.slice(start, start + contentHeight)].map((line) =>
			theme.fg("toolOutput", pad(line, detailWidth)),
		);
		const body = Array.from({ length: height }, (_, i) =>
			this.wide()
				? `${list[i] ?? pad("", listWidth)} ${theme.fg("border", "│")} ${detail[i] ?? pad("", detailWidth)}`
				: ((this.detail ? detail[i] : list[i]) ?? pad("", width)),
		);
		const hint = (id: Parameters<typeof keybindings.getKeys>[0]) => keyLabel(id, { keybindings });
		const footer =
			this.feedback ??
			`${hint("tui.select.up")}/${hint("tui.select.down")} ${this.detail ? "scroll" : "select"} · ${hint("tui.select.confirm")} detail · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} page · ${hint("app.backgroundTasks.kill")} stop group · ${hint("tui.select.cancel")} ${this.detail ? "back" : "close"}${!this.follow ? " · paused" : ""}`;
		return [
			pad(theme.fg("accent", `Background tasks (${this.rows.length ? index + 1 : 0}/${this.rows.length})`), width),
			...body,
			pad(theme.fg("muted", footer), width),
		];
	}
}
