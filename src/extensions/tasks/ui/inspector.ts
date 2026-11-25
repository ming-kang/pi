import type { TaskRead, TaskSnapshot, TasksContext } from "../../../core/tasks/types.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";
import { TaskViewport } from "./viewport.ts";
import { detailLines, outputLines, streamsLog, TASK_IDLE_DISPLAY_MS } from "./views.ts";

const INSPECTOR_CHUNK_BYTES = 48 * 1024;

interface ReadingPosition {
	info: TaskViewport;
	output: TaskViewport;
	/** Whether Output last followed the tail; a change of kind restarts its viewport. */
	tails?: boolean;
	read?: TaskRead;
	/** Exclusive upper byte bound when browsing an earlier chunk of a large log; undefined = latest tail. */
	windowEndByte?: number;
}
interface InspectorOptions {
	host: Pick<TasksContext, "read" | "retain">;
	theme: Theme;
	isOutputVisible(): boolean;
	requestRender(): void;
}

/** Output follows the tail while it is a log or still live; a settled report reads from its first line. */
function tailsOutput(task: TaskSnapshot): boolean {
	return task.output === "log" || !isTaskTerminal(task.status);
}

function sameRead(previous: TaskRead | undefined, next: TaskRead): boolean {
	return (
		previous !== undefined &&
		previous.task.status === next.task.status &&
		previous.totalBytes === next.totalBytes &&
		previous.fromByte === next.fromByte &&
		previous.endByte === next.endByte &&
		previous.readError === next.readError &&
		previous.text === next.text
	);
}

/** Owns the selected task's bounded reads. Reading never acknowledges completion delivery. */
export class TaskInspector {
	task?: TaskSnapshot;
	private readonly options: InspectorOptions;
	private readonly positions = new Map<string, ReadingPosition>();
	private release?: () => void;
	private reading = false;
	private pendingRefresh = false;
	private disposed = false;
	/** Snapshots are immutable, so identity tells when the lines must be rebuilt. */
	private outputCache?: { task: TaskSnapshot; read?: TaskRead; width: number; lines: string[] };
	private detailCache?: { task: TaskSnapshot; width: number; lines: string[]; idleBucket: number };
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
	get pagingEarlier(): boolean {
		return this.position.windowEndByte !== undefined;
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
	followLatest(): void {
		const position = this.position;
		position.windowEndByte = undefined;
		position.output.jump(true);
	}
	loadEarlier(): boolean {
		const task = this.task;
		if (!task || !streamsLog(task)) return false;
		const position = this.position;
		const fromByte = position.read?.fromByte ?? 0;
		if (fromByte <= 0) return false;
		position.windowEndByte = fromByte;
		position.output.jump(false);
		return true;
	}
	loadLater(): boolean {
		const task = this.task;
		if (!task || !streamsLog(task)) return false;
		const position = this.position;
		if (position.windowEndByte === undefined) return false;
		const totalBytes = position.read?.totalBytes ?? 0;
		const nextEnd = position.windowEndByte + INSPECTOR_CHUNK_BYTES;
		if (nextEnd >= totalBytes) {
			position.windowEndByte = undefined;
			position.output.jump(true);
		} else {
			position.windowEndByte = nextEnd;
			position.output.jump(false);
		}
		return true;
	}
	prune(ids: ReadonlySet<string>): void {
		for (const id of this.positions.keys()) if (!ids.has(id)) this.positions.delete(id);
	}
	invalidate(): void {
		this.outputCache = undefined;
		this.detailCache = undefined;
	}
	async refresh(force = false): Promise<void> {
		if (this.disposed || !this.options.isOutputVisible()) return;
		if (this.reading) {
			this.pendingRefresh = true;
			return;
		}
		const task = this.task;
		// Only an attached log streams. A terminal file-less log is read once for its expiry diagnostic.
		const terminalFallback = task?.output === "log" && isTaskTerminal(task.status);
		if (!task || (!streamsLog(task) && !terminalFallback)) return;
		const position = this.position;
		const targetEndByte = position.windowEndByte;
		if (
			!force &&
			position.read &&
			targetEndByte === undefined &&
			(!position.output.follow || isTaskTerminal(position.read.task.status))
		)
			return;
		if (
			!force &&
			position.read &&
			targetEndByte !== undefined &&
			position.read.endByte === targetEndByte &&
			position.read.task.status === task.status
		)
			return;
		this.reading = true;
		let changed = false;
		try {
			const read = await this.options.host.read(task.id, {
				mode: "tail",
				bytes: INSPECTOR_CHUNK_BYTES,
				...(targetEndByte !== undefined ? { endByte: targetEndByte } : {}),
			});
			if (this.disposed || this.task?.id !== task.id) return;
			if (
				targetEndByte === undefined &&
				position.windowEndByte === undefined &&
				!position.output.follow &&
				position.read
			)
				return;
			if (targetEndByte !== position.windowEndByte) return;
			if (!sameRead(position.read, read)) {
				position.read = read;
				changed = true;
			}
		} catch (error) {
			if (
				!this.disposed &&
				this.task?.id === task.id &&
				targetEndByte === position.windowEndByte &&
				(position.output.follow || !position.read || targetEndByte !== undefined)
			) {
				position.read = {
					task,
					text: "",
					readError: `Cannot read output: ${cleanTaskText(String(error))}`,
					totalBytes: 0,
					truncated: false,
				};
				changed = true;
			}
		} finally {
			this.reading = false;
			if (!this.disposed && changed) this.options.requestRender();
			const shouldRerun = this.pendingRefresh || this.task?.id !== task.id;
			this.pendingRefresh = false;
			if (!this.disposed && shouldRerun) await this.refresh();
		}
	}
	output(width: number): string[] {
		const task = this.task;
		if (!task) return [];
		const read = this.position.read;
		const cache = this.outputCache;
		// Activity markers and elapsed time advance between snapshot updates, so live rows repaint uncached.
		const live = !isTaskTerminal(task.status) && !!task.display?.activities?.length;
		if (live || cache?.task !== task || cache.read !== read || cache.width !== width)
			this.outputCache = { task, read, width, lines: outputLines(task, read, this.options.theme, width) };
		return this.outputCache!.lines;
	}
	details(width: number): string[] {
		const task = this.task;
		if (!task) return [];
		const now = Date.now();
		const idleBucket =
			!isTaskTerminal(task.status) &&
			task.lastOutputAt !== undefined &&
			now - task.lastOutputAt >= TASK_IDLE_DISPLAY_MS
				? Math.floor((now - task.lastOutputAt) / 1000)
				: -1;
		const cache = this.detailCache;
		if (cache?.task !== task || cache.width !== width || cache.idleBucket !== idleBucket)
			this.detailCache = { task, width, idleBucket, lines: detailLines(task, this.options.theme, width, now) };
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
