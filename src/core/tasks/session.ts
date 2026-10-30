import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { CustomMessage } from "../messages.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { truncateHead } from "../tools/truncate.ts";
import { getTaskUsageRecord } from "../usage-totals.ts";
import { TASK_RECORD_TYPE, TASK_SNAPSHOT_VERSION } from "./codec.ts";
import { TaskDelivery } from "./delivery.ts";
import { TaskContextReminder } from "./reminder.ts";
import { TaskRuntime } from "./runtime.ts";
import type { TaskSnapshot } from "./types.ts";

interface TaskSessionOptions {
	manager: SessionManager;
	backgroundAllowed?: boolean;
	/** The main session owns input queues, preflight and idle state. */
	canDeliver(): boolean;
	/**
	 * Start a task-message/completion turn, or enqueue it and return waitForPersistence().
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
	private waitInterrupt = new AbortController();
	private readonly contextReminder = new TaskContextReminder();
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

	get waitInterruptSignal(): AbortSignal {
		return this.waitInterrupt.signal;
	}

	/** End only current task waits; the next wait observes a fresh signal. */
	interruptWaits(): void {
		const previous = this.waitInterrupt;
		this.waitInterrupt = new AbortController();
		previous.abort();
	}

	noteCompaction(): void {
		this.contextReminder.compacted();
	}

	projectContextReminder(messages: AgentMessage[]): AgentMessage[] {
		return this.contextReminder.project(this.service, messages);
	}

	noteAssistantCompleted(): void {
		this.contextReminder.assistantCompleted();
	}

	get quarantinedSettlements(): readonly QuarantinedTaskSettlement[] {
		return structuredClone(this.quarantine);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled && this.options.backgroundAllowed !== false;
		this.service.setEnabled(this.enabled);
	}

	/**
	 * Running tasks that navigating to `targetId` would cancel, since results are saved on their
	 * launch branch. Mirrors navigateTree's destination: selecting a user or custom message moves
	 * the leaf to its parent.
	 */
	stoppedByTreeNavigation(targetId: string, service = this.service): TaskSnapshot[] {
		const target = this.options.manager.getEntry(targetId);
		if (!target) return [];
		const leafId =
			(target.type === "message" && target.message.role === "user") || target.type === "custom_message"
				? target.parentId
				: targetId;
		return service.activeOutsideBranch(this.branchIds(leafId));
	}

	/** Cancel running tasks launched outside the branch ending at `leafId`. */
	cancelOutsideBranch(leafId: string | null): Promise<void> {
		const ancestors = this.branchIds(leafId);
		this.delivery.dropOutsideBranch(ancestors);
		return this.service.cancelOutsideBranch(ancestors);
	}

	private branchIds(leafId: string | null): Set<string> {
		return new Set(leafId === null ? [] : this.options.manager.getBranch(leafId).map((entry) => entry.id));
	}

	/** Called after the old service's bounded shutdown, while lifecycle delivery is paused. */
	replaceService(): void {
		this.contextReminder.reset();
		this.service.close();
		this._service = this.createService();
		this.delivery.retry();
	}

	private createService(): TaskRuntime {
		const { manager, backgroundAllowed } = this.options;
		const generation = ++this.generation;
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		const waitInterruptSignal = () => this.waitInterruptSignal;
		const service: TaskRuntime = new TaskRuntime({
			enabled: this.enabled,
			backgroundAllowed,
			session: {
				get waitInterruptSignal() {
					return waitInterruptSignal();
				},
				prepareWait: (toolCallId, taskId) => this.delivery.prepareWait(toolCallId, taskId),
				stoppedByTreeNavigation: (targetId): TaskSnapshot[] => this.stoppedByTreeNavigation(targetId, service),
			},
			anchor: () => manager.getLeafId(),
			onCleanupError: (message) => this.warn("task_cleanup", message),
			onMessage: (task, message) => this.delivery.enqueue(service, task, message),
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
		const records: unknown[] = [];
		const toolResults = new Map<string, AgentToolResult<unknown>["content"]>();
		for (const entry of this.options.manager.getBranch()) {
			if (entry.type === "custom" && entry.customType === TASK_RECORD_TYPE) records.push(entry.data);
			else if (entry.type === "message" && entry.message.role === "toolResult")
				toolResults.set(entry.message.toolCallId, entry.message.content);
		}
		service.restoreHistory(records, toolResults);
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

	/** One entry per settlement: the bounded terminal snapshot and its first usage settlement. */
	private persistSettlement(task: TaskSnapshot, usage: Usage | undefined): void {
		const manager = this.options.manager;
		const accounted = usage && manager.getEntries().some((entry) => getTaskUsageRecord(entry)?.taskId === task.id);
		// A foreground result is the tool result the transcript already saves; restoration reads it from there.
		const { result: _result, ...metadata } = task;
		const saved = task.mode === "foreground" ? metadata : task;
		const data = JSON.parse(
			JSON.stringify({ version: TASK_SNAPSHOT_VERSION, task: saved, ...(usage && !accounted ? { usage } : {}) }),
		);
		const entry = manager.getEntry(manager.appendCustomEntry(TASK_RECORD_TYPE, data));
		if (!entry) return;
		try {
			this.options.onEntry(entry);
		} catch {
			// Observers cannot interrupt settlement or result publication.
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
		this.contextReminder.reset();
		this.interruptWaits();
		this.service.close();
		this.delivery.dispose();
	}
}
