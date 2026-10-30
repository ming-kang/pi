import type { TaskRead, TaskSnapshot, TasksContext } from "../../../core/tasks/types.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";
import { detailLines, outputLines } from "./views.ts";

interface ReadingPosition {
	info: TaskViewport;
	output: TaskViewport;
	read?: TaskRead;
}
interface InspectorOptions {
	host: Pick<TasksContext, "read" | "retain">;
	theme: Theme;
	requestRender(): void;
}

/** Owns the selected task's bounded reads. Reading never acknowledges completion delivery. */
export class TaskInspector {
	task?: TaskSnapshot;
	private readonly options: InspectorOptions;
	private readonly positions = new Map<string, ReadingPosition>();
	private release?: () => void;
	private reading = false;
	private disposed = false;
	/** Snapshots are immutable, so identity tells when the lines must be rebuilt. */
	private outputCache?: { task: TaskSnapshot; read?: TaskRead; width: number; lines: string[] };
	private detailCache?: { task: TaskSnapshot; status: string; lines: string[] };
	constructor(options: InspectorOptions) {
		this.options = options;
	}
	get position(): ReadingPosition {
		const id = this.task?.id;
		let position = id ? this.positions.get(id) : undefined;
		if (!position) {
			position = { info: new TaskViewport(), output: new TaskViewport(true) };
			if (id) this.positions.set(id, position);
		}
		return position;
	}
	select(task: TaskSnapshot | undefined): void {
		if (this.disposed) return;
		if (this.task?.id !== task?.id) {
			const release = task ? this.options.host.retain(task.id) : undefined;
			const previous = this.release;
			this.release = release;
			previous?.();
		}
		this.task = task;
	}
	prune(ids: ReadonlySet<string>): void {
		for (const id of this.positions.keys()) if (!ids.has(id)) this.positions.delete(id);
	}
	invalidate(): void {
		this.outputCache = undefined;
		this.detailCache = undefined;
	}
	async refresh(): Promise<void> {
		const task = this.task;
		if (this.disposed || !task || this.reading) return;
		const position = this.position;
		if (position.read && (!position.output.follow || isTaskTerminal(position.read.task.status))) return;
		this.reading = true;
		try {
			const read = await this.options.host.read(task.id, { mode: "tail", bytes: 48 * 1024 });
			if (this.disposed || this.task?.id !== task.id || (!position.output.follow && position.read)) return;
			position.read = read;
		} catch (error) {
			if (!this.disposed && this.task?.id === task.id && (position.output.follow || !position.read)) {
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
			if (!this.disposed && this.task?.id !== task.id) await this.refresh();
		}
	}
	output(width: number): string[] {
		const task = this.task;
		if (!task) return [];
		const read = this.position.read;
		const cache = this.outputCache;
		if (cache?.task !== task || cache.read !== read || cache.width !== width)
			this.outputCache = { task, read, width, lines: outputLines(task, read, this.options.theme, width) };
		return this.outputCache!.lines;
	}
	/** `status` carries the runtime, so Details rebuild at most once per displayed tick. */
	details(status: string): string[] {
		const task = this.task;
		if (!task) return [];
		const cache = this.detailCache;
		if (cache?.task !== task || cache.status !== status)
			this.detailCache = { task, status, lines: detailLines(task, status, this.options.theme) };
		return this.detailCache!.lines;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.release?.();
		this.release = undefined;
		this.positions.clear();
	}
}
