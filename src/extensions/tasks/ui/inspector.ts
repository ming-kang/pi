import type { TaskRead, TaskSnapshot, TasksContext } from "../../../core/tasks/types.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";
import { detailLines, outputLines, streamsLog } from "./views.ts";

interface ReadingPosition {
	info: TaskViewport;
	output: TaskViewport;
	/** Whether Output last followed the tail; a change of kind restarts its viewport. */
	tails?: boolean;
	read?: TaskRead;
}
interface InspectorOptions {
	host: Pick<TasksContext, "read" | "retain" | "presentOutput">;
	theme: Theme;
	requestRender(): void;
}

/** Output follows the tail while it is a log or still live; a settled report reads from its first line. */
function tailsOutput(task: TaskSnapshot): boolean {
	return task.output === "log" || !isTaskTerminal(task.status);
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
	private detailCache?: { task: TaskSnapshot; width: number; lines: string[] };
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
		if (!task) return;
		const position = this.position;
		const tails = tailsOutput(task);
		if (position.tails !== tails) {
			position.tails = tails;
			position.output.retarget(tails);
		}
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
		// Only an attached log streams. A terminal file-less log is read once for its expiry diagnostic.
		const terminalFallback = task?.output === "log" && isTaskTerminal(task.status);
		if (this.disposed || !task || (!streamsLog(task) && !terminalFallback) || this.reading) return;
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
		// A live presentation changes with time, not with the snapshot, so it is never cached.
		const live = isTaskTerminal(task.status)
			? undefined
			: this.options.host.presentOutput(task.id, width, this.options.theme);
		if (live) return outputLines(task, undefined, this.options.theme, width, live);
		const read = this.position.read;
		const cache = this.outputCache;
		if (cache?.task !== task || cache.read !== read || cache.width !== width)
			this.outputCache = { task, read, width, lines: outputLines(task, read, this.options.theme, width) };
		return this.outputCache!.lines;
	}
	details(width: number): string[] {
		const task = this.task;
		if (!task) return [];
		const cache = this.detailCache;
		if (cache?.task !== task || cache.width !== width)
			this.detailCache = { task, width, lines: detailLines(task, this.options.theme, width) };
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
