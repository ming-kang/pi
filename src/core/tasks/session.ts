import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { CustomMessage } from "../messages.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { truncateHead } from "../tools/truncate.ts";
import { getTaskUsageRecord, TASK_USAGE_TYPE } from "../usage-totals.ts";
import { TaskDelivery } from "./delivery.ts";
import { TASK_HISTORY_VERSION } from "./history.ts";
import { TaskRuntime } from "./runtime.ts";
import type { TaskSnapshot } from "./types.ts";

interface TaskSessionOptions {
	manager: SessionManager;
	role: "main" | "subagent";
	/** The main session owns input queues, preflight and idle state. */
	canDeliver(): boolean;
	/**
	 * Start a completion turn, or enqueue the message and return waitForPersistence().
	 * The host owns input routing; this adapter owns the queued delivery's lifetime.
	 */
	deliver(message: CustomMessage, waitForPersistence: () => Promise<void>): Promise<void>;
	onEntry(entry: SessionEntry): void;
	onError(event: string, message: string): void;
}

export interface QuarantinedTaskSettlement {
	sessionId: string;
	generation: number;
	task: TaskSnapshot;
	usage?: Usage;
}

/** Session persistence and completion delivery; execution supervision stays in TaskRuntime. */
export class TaskSession {
	private readonly options: TaskSessionOptions;
	private _service: TaskRuntime;
	private enabled = false;
	private disposed = false;
	private generation = 0;
	readonly delivery: TaskDelivery;
	private readonly quarantine: QuarantinedTaskSettlement[] = [];

	constructor(options: TaskSessionOptions) {
		this.options = options;
		this.delivery = new TaskDelivery({
			service: () => this.service,
			canDeliver: options.canDeliver,
			deliver: options.deliver,
			warn: (event, message) => this.warn(event, message),
		});
		this._service = this.createService();
	}

	get service(): TaskRuntime {
		return this._service;
	}

	get quarantinedSettlements(): readonly QuarantinedTaskSettlement[] {
		return structuredClone(this.quarantine);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled && this.options.role === "main";
		this.service.setEnabled(this.enabled);
	}

	/** Called after the old service's bounded shutdown, while lifecycle delivery is paused. */
	replaceService(): void {
		this.service.close();
		this._service = this.createService();
		this.delivery.retry();
	}

	private createService(): TaskRuntime {
		const { manager, role } = this.options;
		const generation = ++this.generation;
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		const service = new TaskRuntime({
			enabled: this.enabled,
			backgroundAllowed: role === "main",
			anchor: () => manager.getLeafId(),
			onCleanupError: (message) => this.warn("task_cleanup", message),
			onSettled: (task, usage) => {
				const onBranch =
					manager.getSessionId() === sessionId &&
					(task.anchorId === null || manager.getBranch().some((entry) => entry.id === task.anchorId));
				if (this.disposed || this.service !== service || !onBranch) {
					this.quarantineSettlement({ sessionId, generation, task, usage }, sessionFile);
					return;
				}
				this.persistSettlement(task, usage);
			},
		});
		this.restoreHistory(service);
		service.subscribe(() => this.delivery.schedule());
		return service;
	}

	restoreHistory(service = this.service): void {
		service.restoreHistory(
			this.options.manager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === "task-result" ? [entry.data] : [])),
		);
	}

	private quarantineSettlement(record: QuarantinedTaskSettlement, sessionFile: string | undefined): void {
		// Never move the active leaf to append late usage: JSONL's last entry also
		// selects its resumed branch. The sidecar is diagnostic evidence only.
		this.quarantine.push(structuredClone(record));
		if (this.quarantine.length > 32) this.quarantine.shift();
		let persistence =
			"Not persisted: only the latest 32 snapshots are retained in quarantinedTaskSettlements; late usage is not accounted in session totals.";
		if (sessionFile) {
			try {
				mkdirSync(dirname(sessionFile), { recursive: true });
				appendFileSync(`${sessionFile}.tasks-late.jsonl`, `${JSON.stringify({ version: 1, ...record })}\n`);
				persistence = `Saved diagnostic sidecar: ${sessionFile}.tasks-late.jsonl (not included in normal session totals).`;
			} catch {
				persistence = `Sidecar write failed. ${persistence}`;
			}
		}
		this.warn(
			"task_settlement_quarantined",
			`Late background settlement ${record.task.id} was quarantined. ${persistence}`,
		);
	}

	private persistSettlement(task: TaskSnapshot, usage: Usage | undefined): void {
		const manager = this.options.manager;
		const appended: SessionEntry[] = [];
		const append = (customType: string, data: unknown) => {
			const entry = manager.getEntry(manager.appendCustomEntry(customType, data));
			if (entry) appended.push(entry);
		};
		try {
			if (usage && !manager.getEntries().some((entry) => getTaskUsageRecord(entry)?.taskId === task.id)) {
				append(TASK_USAGE_TYPE, { version: 1, taskId: task.id, usage });
			}
			append("task-result", JSON.parse(JSON.stringify({ version: TASK_HISTORY_VERSION, task })));
		} finally {
			// Complete the writes before observers can replace the runtime or its manager.
			// If a write fails, still report entries that were successfully appended.
			for (const entry of appended) {
				try {
					this.options.onEntry(entry);
				} catch {
					// Observers cannot interrupt settlement or result publication.
				}
			}
		}
	}

	private warn(event: string, message: string): void {
		try {
			this.options.onError(event, truncateHead(message, { maxBytes: 4096, maxLines: 32 }).content);
		} catch {
			// Diagnostics cannot reject settlement, cleanup or scheduled callbacks.
		}
	}

	dispose(): void {
		this.disposed = true;
		this.service.close();
		this.delivery.dispose();
	}
}
