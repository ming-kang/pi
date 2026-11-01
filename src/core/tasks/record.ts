import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { isTaskTerminal, type TaskPresenter, type TaskSnapshot } from "./types.ts";

export const EXPIRED_OUTPUT = "Output has expired: the managed log was released; showing the stored result.";

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

type OutputCleanup = () => void | Promise<void>;

/**
 * The runtime's state for one task: its working snapshot, whether it is on the selected branch,
 * the pins that keep it retained, and the managed output it owns. Whether a completion reached
 * the model is a session concern held outside the runtime as a pin. Every lifecycle fact changes
 * through a named method here; the working snapshot changes only through `update()`, which also
 * drops the frozen copy that readers share, so a mutation can never leave a stale snapshot behind.
 */
export class TaskRecord {
	/** Read-only view of the working copy; change it with update(). */
	readonly task: Readonly<TaskSnapshot>;
	/** Settles once the task is terminal and its final snapshot is stored. Never rejects. */
	readonly settlement: Promise<void>;
	private readonly working: TaskSnapshot;
	private frozen?: TaskSnapshot;
	private resolveSettlement!: () => void;
	private onBranch = true;
	private pins = 0;
	private cleanup?: OutputCleanup;
	private expiredReason?: string;
	private presenter?: TaskPresenter;

	constructor(task: TaskSnapshot) {
		this.working = task;
		this.task = task;
		this.settlement = new Promise<void>((resolve) => {
			this.resolveSettlement = resolve;
		});
	}

	/** A terminal record rebuilt from persisted history: nothing is left to run or deliver. */
	static restored(task: TaskSnapshot, readError: string | undefined): TaskRecord {
		const record = new TaskRecord(task);
		record.expiredReason = readError;
		record.settle();
		return record;
	}

	/** Terminal: nothing is left to run. Derived from the status so it can never disagree with it. */
	get settled(): boolean {
		return isTaskTerminal(this.working.status);
	}

	/** The executor's live Output renderer; held in memory for a running task only. */
	setPresenter(presenter: TaskPresenter | undefined): void {
		this.presenter = presenter;
	}

	/** Live Output while running; `undefined` once settled, without a presenter, or if the presenter throws. */
	present(width: number, theme: Theme): string[] | undefined {
		if (this.settled || !this.presenter) return undefined;
		try {
			const lines = this.presenter(width, theme);
			return Array.isArray(lines) ? lines : undefined;
		} catch {
			// An executor bug must not break the panel; it falls back to the default view.
			return undefined;
		}
	}

	/** Called once, after the terminal snapshot is final. */
	settle(): void {
		this.presenter = undefined;
		this.resolveSettlement();
	}

	update(mutate: (task: TaskSnapshot) => void): void {
		try {
			mutate(this.working);
		} finally {
			this.frozen = undefined;
		}
	}

	/** Readers share one frozen copy, so polling and status rendering never clone unchanged output. */
	snapshot(): TaskSnapshot {
		this.frozen ??= freeze(structuredClone(this.working));
		return this.frozen;
	}

	/** Whether the launch anchor is on the selected branch. */
	get visible(): boolean {
		return this.onBranch;
	}

	setVisible(visible: boolean): void {
		this.onBranch = visible;
	}

	/** Keep the record, and its output, retained until the returned release runs. Idempotent. */
	pin(): () => void {
		this.pins++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.pins--;
		};
	}

	/** Settled and unpinned: bounded history that retention may evict. */
	get inHistory(): boolean {
		return this.settled && this.pins === 0;
	}

	/** Why the output could not be read from a log: it expired, or was never kept. */
	get readError(): string | undefined {
		return this.expiredReason;
	}

	/** Register the one output file this task owns; `cleanup` deletes it when retention lets go. */
	attachOutput(path: string, cleanup?: OutputCleanup): void {
		if (this.cleanup) throw new Error("Managed output is already registered");
		this.cleanup = cleanup;
		this.update((task) => {
			task.outputPath = path;
		});
	}

	/**
	 * Release the managed output once nothing retains it. Returns the owner's cleanup to run, if
	 * any; the snapshot keeps its final bounded text, so an expired file is never needed again.
	 */
	expireOutput(): OutputCleanup | undefined {
		if (!this.settled || this.pins > 0 || !this.cleanup) return undefined;
		const cleanup = this.cleanup;
		this.cleanup = undefined;
		this.update((task) => {
			task.outputPath = undefined;
		});
		this.expiredReason = EXPIRED_OUTPUT;
		return cleanup;
	}
}
