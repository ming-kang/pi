/** Task selection and layout; execution modules own the two content regions. */
import {
	type Component,
	type Focusable,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { isTaskTerminal, type TaskRead, type TaskSnapshot, type TasksContext } from "../../../core/tasks/types.ts";
import type { TaskView, TaskViewProvider, TaskViewRegistry } from "../../../core/tasks/view.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import { keyLabel } from "../components/keybinding-hints.ts";
import { STATUS_SPINNER_INTERVAL_MS, statusMarker } from "../components/status-marker.ts";
import type { Theme } from "../theme/theme.ts";
import { fallbackTaskView } from "./fallback-view.ts";
import { runtimeLabel } from "./task-view.ts";
import { TaskViewport } from "./viewport.ts";

export type TasksManagerHost = Pick<TasksContext, "list" | "read" | "kill" | "subscribe" | "retain">;
export interface TasksMenuOptions {
	tui: { requestRender(): void; terminal: { rows: number; columns: number } };
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	host: TasksManagerHost;
	views?: Pick<TaskViewRegistry, "get" | "subscribe">;
	onClose(): void;
	pollIntervalMs?: number;
}
interface Position {
	info: TaskViewport;
	output: TaskViewport;
	read?: TaskRead;
}
type Focus = "list" | "info" | "output";
const clean = (text: string) => sanitizeBinaryOutput(stripTerminalSequences(text));
const pad = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…", true);

export class TasksMenu implements Component, Focusable {
	focused = false;
	private readonly options: TasksMenuOptions;
	private tasks: TaskSnapshot[] = [];
	private selected?: TaskSnapshot;
	private releasePin?: () => void;
	private view?: TaskView;
	private provider?: TaskViewProvider;
	private viewTaskId?: string;
	private viewSnapshot?: TaskSnapshot;
	private viewRead?: TaskRead;
	private viewGeneration = 0;
	private viewError?: string;
	private readonly positions = new Map<string, Position>();
	private focus: Focus = "list";
	private width: number;
	private listHeight = 1;
	private pendingKill?: string;
	private killTimer?: ReturnType<typeof setTimeout>;
	private feedback?: string;
	private readonly pollTimer: ReturnType<typeof setInterval>;
	private animationTimer?: ReturnType<typeof setInterval>;
	private readonly unsubscribe: () => void;
	private readonly unsubscribeViews?: () => void;
	private reading = false;
	private disposed = false;
	private lastFrame = "";

	constructor(options: TasksMenuOptions) {
		this.options = options;
		this.width = options.tui.terminal.columns;
		this.sync();
		this.unsubscribe = options.host.subscribe(() => {
			this.sync();
			if (this.selected && isTaskTerminal(this.selected.status)) this.queueTick();
		});
		this.unsubscribeViews = options.views?.subscribe(() => {
			this.syncView();
			this.queueTick();
		});
		this.pollTimer = setInterval(() => this.queueTick(), options.pollIntervalMs ?? 1000);
		this.pollTimer.unref?.();
		this.queueTick();
	}
	invalidate(): void {
		this.lastFrame = "";
		this.view?.info.invalidate();
		this.view?.output.invalidate();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.pollTimer);
		clearInterval(this.animationTimer);
		this.clearKill();
		this.unsubscribe();
		this.unsubscribeViews?.();
		this.disposeView();
		this.releasePin?.();
		this.positions.clear();
	}
	private sync(): void {
		if (this.disposed) return;
		const all = this.options.host.list();
		this.tasks = all
			.filter((task) => !isTaskTerminal(task.status))
			.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
		const watched = all.find((task) => task.id === this.selected?.id);
		if (watched) this.selected = watched;
		else this.select(this.tasks[0]);
		// The watched terminal task is absent from the selectable list.
		const retained = new Set([...this.tasks.map((task) => task.id), this.selected?.id]);
		for (const id of this.positions.keys()) if (!retained.has(id)) this.positions.delete(id);
		if (this.pendingKill && !this.tasks.some((task) => task.id === this.pendingKill)) this.clearKill();
		this.syncView();
		if (this.tasks.some((task) => task.status === "running" || task.status === "stopping")) {
			if (!this.animationTimer) {
				this.animationTimer = setInterval(() => this.options.tui.requestRender(), STATUS_SPINNER_INTERVAL_MS);
				this.animationTimer.unref?.();
			}
		} else {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}
	private select(task: TaskSnapshot | undefined): void {
		if (task?.id === this.selected?.id) {
			this.selected = task;
			return;
		}
		const release = task ? this.options.host.retain(task.id) : undefined;
		const previous = this.releasePin;
		this.selected = task;
		this.releasePin = release;
		previous?.();
		this.clearKill();
		this.syncView();
	}
	private disposeView(): void {
		this.viewGeneration++;
		this.viewSnapshot = undefined;
		this.viewRead = undefined;
		try {
			this.view?.dispose?.();
		} catch {
			/* Renderer cleanup cannot affect execution. */
		}
		this.view = undefined;
	}
	private syncView(): void {
		const provider = this.selected ? (this.options.views?.get(this.selected.kind) ?? fallbackTaskView) : undefined;
		if (provider === this.provider && this.viewTaskId === this.selected?.id) return;
		this.disposeView();
		this.provider = provider;
		this.viewTaskId = this.selected?.id;
		this.viewError = undefined;
		if (!provider) return;
		const generation = this.viewGeneration;
		try {
			this.view = provider.create({
				theme: this.options.theme,
				requestRender: () => {
					if (!this.disposed && generation === this.viewGeneration) this.options.tui.requestRender();
				},
			});
		} catch (error) {
			this.failView(error);
		}
	}
	private failView(error: unknown): void {
		this.disposeView();
		this.viewError = `Task view unavailable: ${clean(String(error))}`;
		this.view = fallbackTaskView.create({ theme: this.options.theme, requestRender: () => {} });
	}
	private position(): Position {
		const id = this.selected?.id ?? "";
		let position = this.positions.get(id);
		if (!position) {
			position = { info: new TaskViewport(), output: new TaskViewport(this.provider?.outputMode === "tail") };
			if (id) this.positions.set(id, position);
		}
		return position;
	}
	private queueTick(): void {
		void this.tick().catch(() => {
			/* The observer cannot reject execution. */
		});
	}
	private async tick(): Promise<void> {
		if (this.disposed) return;
		this.sync();
		await this.refresh();
		if (this.disposed) return;
		const frame = this.render(this.width).join("\n");
		if (frame !== this.lastFrame) {
			this.lastFrame = frame;
			this.options.tui.requestRender();
		}
	}
	private async refresh(): Promise<void> {
		const task = this.selected;
		if (!task || this.provider?.outputMode !== "tail" || this.viewError || this.reading) return;
		const position = this.position();
		if (position.read && (!position.output.follow || isTaskTerminal(position.read.task.status))) return;
		this.reading = true;
		try {
			const read = await this.options.host.read(task.id, { mode: "tail", bytes: 48 * 1024 });
			if (this.disposed || this.selected?.id !== task.id || (!position.output.follow && position.read)) return;
			position.read = read;
		} catch (error) {
			if (!this.disposed && this.selected?.id === task.id && (position.output.follow || !position.read)) {
				position.read = {
					task,
					text: "",
					readError: `Cannot read output: ${clean(String(error))}`,
					totalBytes: 0,
					truncated: false,
				};
			}
		} finally {
			this.reading = false;
			if (!this.disposed && this.selected?.id !== task.id) this.queueTick();
		}
	}
	private clearKill(): void {
		clearTimeout(this.killTimer);
		this.killTimer = undefined;
		this.pendingKill = undefined;
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		this.feedback = undefined;
		if (this.pendingKill) {
			const id = this.pendingKill;
			this.clearKill();
			if (data === "y" || data === "Y") {
				try {
					this.feedback = this.options.host.kill(id) ? `Stopping ${id}…` : "No new cancellation requested.";
				} catch (error) {
					this.feedback = clean(String(error));
				}
			}
		} else if (kb.matches(data, "tui.select.cancel")) {
			if (this.focus !== "list") this.focus = "list";
			else {
				this.dispose();
				this.options.onClose();
				return;
			}
		} else if (kb.matches(data, "app.tasks.kill")) {
			if (this.selected && !isTaskTerminal(this.selected.status) && this.selected.status !== "stopping") {
				this.pendingKill = this.selected.id;
				this.killTimer = setTimeout(() => {
					this.clearKill();
					this.options.tui.requestRender();
				}, 5000);
				this.killTimer.unref?.();
			}
		} else if (kb.matches(data, "app.tasks.focusList")) this.focus = "list";
		else if (kb.matches(data, "app.tasks.focusInfo")) this.focus = "info";
		else if (kb.matches(data, "app.tasks.focusPreview") || kb.matches(data, "tui.select.confirm"))
			this.focus = "output";
		else {
			const pageUp = kb.matches(data, this.focus === "list" ? "tui.select.pageUp" : "tui.editor.pageUp");
			const pageDown = kb.matches(data, this.focus === "list" ? "tui.select.pageDown" : "tui.editor.pageDown");
			const direction =
				pageUp || kb.matches(data, "tui.select.up") ? -1 : pageDown || kb.matches(data, "tui.select.down") ? 1 : 0;
			if (direction) {
				this.render(this.width);
				if (this.focus === "list" && this.tasks.length) {
					const index = this.tasks.findIndex((task) => task.id === this.selected?.id);
					const next =
						index < 0
							? direction > 0
								? 0
								: this.tasks.length - 1
							: pageUp || pageDown
								? Math.max(0, Math.min(this.tasks.length - 1, index + direction * this.listHeight))
								: (index + direction + this.tasks.length) % this.tasks.length;
					this.select(this.tasks[next]);
					this.sync();
				} else if (this.focus !== "list")
					this.position()[this.focus].move(
						direction,
						pageUp || pageDown,
						this.focus === "output" && this.provider?.outputMode === "tail",
					);
			} else if (this.focus !== "list") {
				try {
					this.view?.[this.focus].handleInput?.(data);
				} catch (error) {
					this.failView(error);
				}
			}
		}
		this.queueTick();
		this.options.tui.requestRender();
	}
	private regionLines(width: number): { info: string[]; output: string[] } {
		if (!this.selected || !this.view) return { info: [], output: [] };
		try {
			const read = this.position().read;
			if (this.selected !== this.viewSnapshot || read !== this.viewRead) {
				this.view.update(this.selected, read);
				this.viewSnapshot = this.selected;
				this.viewRead = read;
			}
			return { info: this.view.info.render(width), output: this.view.output.render(width) };
		} catch (error) {
			this.failView(error);
			this.view!.update(this.selected);
			return { info: this.view!.info.render(width), output: this.view!.output.render(width) };
		}
	}
	render(width: number): string[] {
		if (width < 1) return [];
		this.width = width;
		const { theme, keybindings, tui } = this.options;
		const height = tui.terminal.rows;
		const rule = new DynamicBorder((text) => theme.fg("border", text)).render(width)[0] ?? "";
		if (width < 60 || height < 14)
			return [
				rule,
				pad("Terminal too small for /tasks — resize to 60×14.", width),
				pad(`${keyLabel("tui.select.cancel", { keybindings })} close`, width),
				...Array.from({ length: Math.max(0, height - 3) }, () => pad("", width)),
			].slice(0, height);
		const wide = width >= 100;
		const bodyHeight = height - 5;
		const listWidth = wide ? Math.min(40, Math.max(28, Math.floor(width * 0.3))) : width;
		const rightWidth = wide ? width - listWidth - 1 : width;
		this.listHeight = wide ? bodyHeight : Math.min(4, Math.max(1, this.tasks.length));
		const selectedIndex = this.tasks.findIndex((task) => task.id === this.selected?.id);
		const first = Math.max(0, selectedIndex - this.listHeight + 1);
		const list = this.tasks.slice(first, first + this.listHeight).map((task) => {
			const marker = statusMarker(task.status);
			const selected = task.id === this.selected?.id;
			const cursor = selected ? theme.fg(this.focus === "list" ? "accent" : "muted", "→ ") : "  ";
			const suffix = theme.fg("dim", `${task.mode === "foreground" ? "fg" : "bg"} · ${runtimeLabel(task)}`);
			const prefix = `${cursor}${theme.fg(marker.color, marker.glyph)} `;
			const label = clean(task.command ?? task.title).replace(/\s+/g, " ");
			return `${prefix}${pad(theme.fg(selected && this.focus === "list" ? "accent" : "text", label), listWidth - visibleWidth(prefix) - visibleWidth(suffix) - 1)} ${suffix}`;
		});
		if (!list.length) list.push(theme.fg("muted", "No ongoing tasks."));
		const available = bodyHeight - (wide ? 0 : this.listHeight);
		const regions = this.regionLines(rightWidth);
		const task = this.selected;
		const common = task
			? [
					`Status    ${task.status} · ${task.mode} · ${runtimeLabel(task)}`,
					`Task      ${task.id}`,
					...(task.error ? [theme.fg("error", clean(task.error))] : []),
				]
			: [theme.fg("muted", "Select an ongoing task.")];
		if (this.viewError) common.push(theme.fg("error", this.viewError));
		const infoHeight = Math.max(1, Math.min(Math.floor(available * 0.4), common.length + regions.info.length));
		const outputHeight = Math.max(1, available - infoHeight - 2);
		const position = this.position();
		const info = position.info.layout([...common, ...regions.info], rightWidth, infoHeight);
		const output = position.output.layout(regions.output, rightWidth, outputHeight);
		const heading = (label: string, focus: Focus, suffix: string) => {
			const text = `─ ${theme.fg(this.focus === focus ? "accent" : "muted", label)} ${theme.fg("dim", suffix)} `;
			return pad(
				text + theme.fg("borderMuted", "─".repeat(Math.max(0, rightWidth - visibleWidth(text)))),
				rightWidth,
			);
		};
		const tail =
			this.provider?.outputMode === "tail" && !this.viewError
				? ` · ${position.output.follow ? "following" : "browsing"}`
				: "";
		const right = [
			heading("Information", "info", position.info.range),
			...info,
			...Array.from({ length: Math.max(0, infoHeight - info.length) }, () => ""),
			heading("Output", "output", position.output.range + tail),
			...output,
		];
		const body = wide
			? Array.from(
					{ length: bodyHeight },
					(_, i) =>
						`${pad(list[i] ?? "", listWidth)}${theme.fg("borderMuted", "│")}${pad(right[i] ?? "", rightWidth)}`,
				)
			: [...list, ...Array.from({ length: Math.max(0, this.listHeight - list.length) }, () => ""), ...right];
		while (body.length < bodyHeight) body.push("");
		const hint = (id: Parameters<typeof keybindings.getKeys>[0]) => keyLabel(id, { keybindings });
		const hints =
			this.focus === "list"
				? `${hint("tui.select.up")}/${hint("tui.select.down")} select · ${hint("app.tasks.focusInfo")} info · ${hint("app.tasks.focusPreview")} output · ${hint("app.tasks.kill")} stop · ${hint("tui.select.cancel")} close`
				: `${hint("tui.select.up")}/${hint("tui.select.down")} scroll · ${hint("tui.editor.pageUp")}/${hint("tui.editor.pageDown")} page · ${hint("app.tasks.focusList")} list · ${hint("app.tasks.focusInfo")} info · ${hint("app.tasks.focusPreview")} output · ${hint("tui.select.cancel")} back`;
		const title =
			theme.fg("accent", theme.bold("Tasks")) +
			(this.tasks.length ? theme.fg("muted", ` · ${this.tasks.length} ongoing`) : "");
		const footer = this.pendingKill
			? theme.fg("warning", `Stop ${this.pendingKill} (whole task)? y/N`)
			: theme.fg("dim", this.feedback ?? hints);
		return [rule, title, ...body.slice(0, bodyHeight), rule, footer, rule].map((line) => pad(line, width));
	}
}
