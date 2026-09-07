import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { CustomMessage } from "../messages.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { truncateHead } from "../tools/truncate.ts";
import { BACKGROUND_USAGE_TYPE, getBackgroundUsageRecord } from "../usage-totals.ts";
import { BACKGROUND_HISTORY_VERSION } from "./history.ts";
import { backgroundCompletionMessage } from "./presentation.ts";
import { BackgroundService } from "./service.ts";
import { type BackgroundTask, isBackgroundTerminal } from "./types.ts";

interface BackgroundSessionOptions {
	manager: SessionManager;
	role: "main" | "subagent";
	/** The main session owns prompt queues, preflight and idle state. */
	canDeliver(): boolean;
	deliver(message: CustomMessage): Promise<void>;
	onEntry(entry: SessionEntry): void;
	onError(event: string, message: string): void;
}

export interface QuarantinedBackgroundSettlement {
	sessionId: string;
	generation: number;
	task: BackgroundTask;
	usage?: Usage;
}

interface Delivery {
	id: string;
	service: BackgroundService;
	persisted: boolean;
}

/** Session persistence and completion delivery; execution supervision stays in BackgroundService. */
export class BackgroundSession {
	private readonly options: BackgroundSessionOptions;
	private _service: BackgroundService;
	private enabled = false;
	private disposed = false;
	private generation = 0;
	private pauses = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private delivery?: Delivery;
	private readonly failures = new Set<string>();
	private readonly quarantine: QuarantinedBackgroundSettlement[] = [];

	constructor(options: BackgroundSessionOptions) {
		this.options = options;
		this._service = this.createService();
	}

	get service(): BackgroundService {
		return this._service;
	}

	get quarantinedSettlements(): readonly QuarantinedBackgroundSettlement[] {
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
		this.failures.clear();
	}

	private createService(): BackgroundService {
		const { manager, role } = this.options;
		const generation = ++this.generation;
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		const service = new BackgroundService({
			enabled: this.enabled,
			role,
			anchor: () => manager.getLeafId(),
			onCleanupError: (message) => this.warn("background_cleanup", message),
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
		service.subscribe(() => this.schedule());
		return service;
	}

	restoreHistory(service = this.service): void {
		service.restoreHistory(
			this.options.manager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "background-task-result" ? [entry.data] : [],
				),
		);
	}

	private quarantineSettlement(record: QuarantinedBackgroundSettlement, sessionFile: string | undefined): void {
		// Never move the active leaf to append late usage: JSONL's last entry also
		// selects its resumed branch. The sidecar is diagnostic evidence only.
		this.quarantine.push(structuredClone(record));
		if (this.quarantine.length > 32) this.quarantine.shift();
		let persistence =
			"Not persisted: only the latest 32 snapshots are retained in quarantinedBackgroundSettlements; late usage is not accounted in session totals.";
		if (sessionFile) {
			try {
				mkdirSync(dirname(sessionFile), { recursive: true });
				appendFileSync(`${sessionFile}.background-late.jsonl`, `${JSON.stringify({ version: 1, ...record })}\n`);
				persistence = `Saved diagnostic sidecar: ${sessionFile}.background-late.jsonl (not included in normal session totals).`;
			} catch {
				persistence = `Sidecar write failed. ${persistence}`;
			}
		}
		this.warn(
			"background_settlement_quarantined",
			`Late background settlement ${record.task.id} was quarantined. ${persistence}`,
		);
	}

	private persistSettlement(task: BackgroundTask, usage: Usage | undefined): void {
		const manager = this.options.manager;
		const appended: SessionEntry[] = [];
		const append = (customType: string, data: unknown) => {
			const entry = manager.getEntry(manager.appendCustomEntry(customType, data));
			if (entry) appended.push(entry);
		};
		try {
			if (usage && !manager.getEntries().some((entry) => getBackgroundUsageRecord(entry)?.taskId === task.id)) {
				append(BACKGROUND_USAGE_TYPE, { version: 1, taskId: task.id, usage });
			}
			append("background-task-result", JSON.parse(JSON.stringify({ version: BACKGROUND_HISTORY_VERSION, task })));
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

	/** Nestable across asynchronous preflight and service replacement. */
	pause(): () => void {
		this.pauses++;
		const releaseService = this.service.pause();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.pauses--;
			releaseService();
			this.schedule();
		};
	}

	retry(): void {
		this.failures.clear();
		this.schedule();
	}

	private schedule(): void {
		if (this.disposed || this.timer || this.delivery) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.drain().catch(() =>
				this.warn("background_delivery", "Background notification drain failed; delivery was not confirmed."),
			);
		}, 0);
		this.timer.unref?.();
	}

	private canDeliver(service: BackgroundService): boolean {
		return (
			!this.disposed && service === this.service && service.enabled && this.pauses === 0 && this.options.canDeliver()
		);
	}

	private async drain(): Promise<void> {
		const service = this.service;
		if (this.delivery || !this.canDeliver(service)) return;
		if (this.failures.size) {
			const retained = new Set(service.list().map((task) => task.id));
			for (const id of this.failures) if (!retained.has(id)) this.failures.delete(id);
		}
		const task = service.pendingNotifications().find((task) => !this.failures.has(task.id));
		if (!task || !service.claimNotification(task.id)) return;
		// Exactly one completion turn may be in flight; no separate claim registry.
		const delivery: Delivery = { id: task.id, service, persisted: false };
		this.delivery = delivery;
		let deliveryError: unknown;
		try {
			await this.options.deliver(backgroundCompletionMessage(task));
		} catch (error) {
			deliveryError = error;
		} finally {
			if (!delivery.persisted) {
				service.releaseNotification(task.id);
				if (service === this.service) this.failures.add(task.id);
				const reason = deliveryError instanceof Error ? `: ${deliveryError.message}` : "";
				this.warn(
					"background_delivery",
					`Background completion delivery failed for ${task.id}${reason}; it will retry on the next prompt.`,
				);
			}
			this.delivery = undefined;
			const current = this.service;
			if (this.canDeliver(current) && current.pendingNotifications().some((task) => !this.failures.has(task.id)))
				this.schedule();
		}
	}

	/** Capture before message hooks, invoke only after the resulting message was persisted. */
	messageAcknowledgement(message: AgentMessage): (() => void) | undefined {
		if (message.role !== "custom" || message.customType !== "background-completion") return;
		const details = message.details as { taskId?: unknown } | undefined;
		const delivery = this.delivery;
		if (!delivery || details?.taskId !== delivery.id) return;
		return () => {
			if (delivery.persisted) return;
			delivery.persisted = true;
			delivery.service.markDelivered(delivery.id);
		};
	}

	/** A wait result claims delivery only through its final, persisted marker. */
	acknowledgeWaitResult(details: unknown): void {
		if (!details || typeof details !== "object" || !("backgroundTaskId" in details)) return;
		const id = details.backgroundTaskId;
		if (
			typeof id === "string" &&
			this.service
				.list()
				.some((task) => task.id === id && task.mode === "background" && isBackgroundTerminal(task.status))
		)
			this.service.markDelivered(id);
	}

	dispose(): void {
		this.disposed = true;
		this.service.close();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
