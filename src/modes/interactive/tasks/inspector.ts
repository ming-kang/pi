import type { TaskRead, TaskSnapshot, TasksContext } from "../../../core/tasks/types.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import type { TaskView, TaskViewProvider, TaskViewRegistry } from "../../../core/tasks/view.ts";
import type { Theme } from "../theme/theme.ts";
import { fallbackLogTaskView, fallbackTaskView } from "./fallback-view.ts";
import type { TasksTab } from "./model.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";

interface ReadingPosition {
	info: TaskViewport;
	output: TaskViewport;
	read?: TaskRead;
}
interface InspectorOptions {
	host: Pick<TasksContext, "read" | "retain">;
	views?: Pick<TaskViewRegistry, "get">;
	theme: Theme;
	requestRender(): void;
}

/** Owns the selected view and bounded reads. Reading never acknowledges completion delivery. */
export class TaskInspector {
	task?: TaskSnapshot;
	error?: string;
	private readonly options: InspectorOptions;
	private readonly positions = new Map<string, ReadingPosition>();
	private release?: () => void;
	private view?: TaskView;
	private provider?: TaskViewProvider;
	private generation = 0;
	private reading = false;
	private disposed = false;
	private viewSnapshot?: TaskSnapshot;
	private viewRead?: TaskRead;
	constructor(options: InspectorOptions) {
		this.options = options;
	}
	get tail(): boolean {
		return this.error ? this.task?.format === "log" : this.provider?.outputMode === "tail";
	}
	get position(): ReadingPosition {
		const id = this.task?.id;
		let position = id ? this.positions.get(id) : undefined;
		if (!position) {
			position = { info: new TaskViewport(), output: new TaskViewport(this.tail) };
			if (id) this.positions.set(id, position);
		}
		return position;
	}
	select(task: TaskSnapshot | undefined): void {
		if (this.disposed) return;
		const changed = this.task?.id !== task?.id;
		if (changed) {
			const release = task ? this.options.host.retain(task.id) : undefined;
			const previous = this.release;
			this.release = release;
			this.task = task;
			previous?.();
		} else this.task = task;
		const provider = task
			? (this.options.views?.get(task.kind) ?? (task.format === "log" ? fallbackLogTaskView : fallbackTaskView))
			: undefined;
		if (!changed && provider === this.provider) return;
		this.disposeView();
		this.provider = provider;
		this.error = undefined;
		if (!provider) return;
		const generation = this.generation;
		try {
			this.view = provider.create({
				theme: this.options.theme,
				requestRender: () => {
					if (!this.disposed && generation === this.generation) this.options.requestRender();
				},
			});
		} catch (error) {
			this.fail(error);
		}
	}
	prune(ids: ReadonlySet<string>): void {
		for (const id of this.positions.keys()) if (!ids.has(id)) this.positions.delete(id);
	}
	invalidate(): void {
		this.viewSnapshot = undefined;
		try {
			this.view?.info.invalidate();
			this.view?.output.invalidate();
		} catch (error) {
			this.fail(error);
		}
	}
	private disposeView(): void {
		this.generation++;
		this.viewSnapshot = undefined;
		this.viewRead = undefined;
		try {
			this.view?.dispose?.();
		} catch {
			/* A renderer never owns execution. */
		}
		this.view = undefined;
	}
	private fail(error: unknown): void {
		this.disposeView();
		this.error = `Task view unavailable: ${cleanTaskText(String(error))}`;
		this.view = fallbackTaskView.create({ theme: this.options.theme, requestRender: () => {} });
	}
	async refresh(): Promise<void> {
		const task = this.task;
		if (this.disposed || !task || !this.tail || this.reading) return;
		const position = this.position;
		if (position.read && (!position.output.follow || isTaskTerminal(position.read.task.status))) return;
		this.reading = true;
		const generation = this.generation;
		try {
			const read = await this.options.host.read(task.id, { mode: "tail", bytes: 48 * 1024 });
			if (
				this.disposed ||
				this.task?.id !== task.id ||
				generation !== this.generation ||
				(!position.output.follow && position.read)
			)
				return;
			position.read = read;
		} catch (error) {
			if (
				!this.disposed &&
				this.task?.id === task.id &&
				generation === this.generation &&
				(position.output.follow || !position.read)
			) {
				position.read = {
					task,
					text: "",
					readError: `Cannot read output: ${cleanTaskText(String(error))}`,
					totalBytes: 0,
					truncated: false,
				};
			}
		} finally {
			this.reading = false;
			if (!this.disposed) this.options.requestRender();
			if (!this.disposed && (this.task?.id !== task.id || generation !== this.generation)) await this.refresh();
		}
	}
	lines(tab: TasksTab, width: number): string[] {
		if (!this.task || !this.view) return [];
		try {
			const read = this.position.read;
			if (this.task !== this.viewSnapshot || read !== this.viewRead) {
				this.view.update(this.task, read);
				this.viewSnapshot = this.task;
				this.viewRead = read;
			}
			return this.view[tab].render(width);
		} catch (error) {
			this.fail(error);
			this.view!.update(this.task, this.position.read);
			return this.view![tab].render(width);
		}
	}
	handleInput(tab: TasksTab, data: string): void {
		try {
			this.view?.[tab].handleInput?.(data);
		} catch (error) {
			this.fail(error);
		}
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.disposeView();
		this.release?.();
		this.release = undefined;
		this.positions.clear();
	}
}
