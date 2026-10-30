import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessage } from "../messages.ts";
import { taskCompletionMessage, taskMessage } from "./presentation.ts";
import type { TaskRuntime } from "./runtime.ts";
import { isTaskTerminal, type TaskSnapshot } from "./types.ts";

export interface TaskDeliveryOptions {
	service(): TaskRuntime;
	canDeliver(): boolean;
	deliver(message: CustomMessage, waitForPersistence: () => Promise<void>): Promise<void>;
	warn(event: string, message: string): void;
}
interface Delivery {
	id: string;
	service: TaskRuntime;
	/** Present for terminal results; absent for explicit executor messages. */
	completionId?: string;
	/** Agent-core preserves message identity; extension rewrites mutate it in place. */
	message: CustomMessage;
	phase: "pending" | "started" | "persisted";
	queued?: { resolve(): void; reject(reason: Error): void };
}

interface QueuedMessage {
	id: string;
	service: TaskRuntime;
	anchorId: string | null;
	message: CustomMessage;
}

/** Explicit messages and results are delivered independently of execution handles and retained output. */
export class TaskDelivery {
	private readonly options: TaskDeliveryOptions;
	private disposed = false;
	private pauses = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private delivery?: Delivery;
	private readonly messages: QueuedMessage[] = [];
	private messageSequence = 0;
	private readonly failures = new Set<string>();
	private readonly waits = new Map<string, { service: TaskRuntime; taskId: string; release(): void }>();
	constructor(options: TaskDeliveryOptions) {
		this.options = options;
	}
	private get service(): TaskRuntime {
		return this.options.service();
	}
	private warn(event: string, message: string): void {
		this.options.warn(event, message);
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
		for (let index = this.messages.length - 1; index >= 0; index--)
			if (this.messages[index]!.service !== this.service) this.messages.splice(index, 1);
		this.failures.clear();
		this.schedule();
	}

	/** Explicit messages share completion delivery's queue, pauses and persistence receipts. */
	enqueue(service: TaskRuntime, task: TaskSnapshot, text: string): boolean {
		if (this.disposed || service.closed || service !== this.service || this.messages.length >= 32) return false;
		this.messages.push({
			id: `${task.id}:message-${++this.messageSequence}`,
			service,
			anchorId: task.anchorId,
			message: taskMessage(task, text),
		});
		this.schedule();
		return true;
	}

	/** Drop work that has not left this queue when its launch branch is hidden. */
	dropOutsideBranch(ancestors: ReadonlySet<string>): void {
		for (let index = this.messages.length - 1; index >= 0; index--) {
			const item = this.messages[index]!;
			if (item.anchorId === null || ancestors.has(item.anchorId)) continue;
			this.messages.splice(index, 1);
			this.failures.delete(item.id);
		}
	}

	schedule(): void {
		if (this.disposed || this.timer || this.delivery) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.drain().catch(() =>
				this.warn("task_delivery", "Background notification drain failed; delivery was not confirmed."),
			);
		}, 0);
		this.timer.unref?.();
	}

	private canDeliver(service: TaskRuntime, allowDisabled = false): boolean {
		return (
			!this.disposed &&
			!service.closed &&
			service === this.service &&
			(allowDisabled || service.enabled) &&
			this.pauses === 0 &&
			this.options.canDeliver()
		);
	}

	private async drain(): Promise<void> {
		if (this.delivery) return;
		const service = this.service;
		if (this.failures.size) {
			const retained = new Set(service.list().map((task) => task.id));
			const messages = new Set(this.messages.map((item) => item.id));
			for (const id of this.failures) if (!retained.has(id) && !messages.has(id)) this.failures.delete(id);
		}
		const queued = this.messages.find((item) => !this.failures.has(item.id) && this.canDeliver(item.service, true));
		let delivery: Delivery;
		if (queued) {
			delivery = { id: queued.id, service: queued.service, message: queued.message, phase: "pending" };
		} else {
			if (!this.canDeliver(service)) return;
			const task = service.pendingNotifications().find((task) => !this.failures.has(task.id));
			if (!task || !service.claimNotification(task.id)) return;
			delivery = {
				id: task.id,
				completionId: task.id,
				service,
				message: taskCompletionMessage(task),
				phase: "pending",
			};
		}
		// Exactly one task message or completion may be in flight, whether queued for
		// steering or running its own turn; there is no separate claim registry.
		this.delivery = delivery;
		let deliveryError: unknown;
		try {
			await this.options.deliver(
				delivery.message,
				() =>
					new Promise<void>((resolve, reject) => {
						if (delivery.phase === "persisted") resolve();
						else delivery.queued = { resolve, reject };
					}),
			);
		} catch (error) {
			deliveryError = error;
		} finally {
			if (delivery.phase !== "persisted") {
				if (delivery.completionId) delivery.service.releaseNotification(delivery.completionId);
				if (delivery.service === this.service) this.failures.add(delivery.id);
				const reason = deliveryError instanceof Error ? `: ${deliveryError.message}` : "";
				this.warn(
					"task_delivery",
					`${delivery.completionId ? "Background completion" : "Task message"} delivery failed for ${delivery.id}${reason}; it will retry on the next input.`,
				);
			}
			this.delivery = undefined;
			const current = this.service;
			const messagePending = this.messages.some(
				(item) => !this.failures.has(item.id) && this.canDeliver(item.service, true),
			);
			const completionPending =
				this.canDeliver(current) && current.pendingNotifications().some((task) => !this.failures.has(task.id));
			if (messagePending || completionPending) this.schedule();
		}
	}

	/** Record dequeueing before message hooks can fail or rewrite the notification. */
	messageStarted(message: AgentMessage): void {
		const delivery = this.delivery;
		if (delivery?.message === message && delivery.phase === "pending") delivery.phase = "started";
	}

	/** A queued message that was never emitted remains claimed for the next run. */
	agentEnded(): void {
		this.releaseWaits();
		const delivery = this.delivery;
		if (delivery?.phase === "started") {
			delivery.queued?.reject(new Error("the task message was not persisted"));
		}
	}

	queueCleared(): void {
		this.delivery?.queued?.reject(new Error("the task message was dequeued before delivery"));
	}

	/** Acknowledge only successful appends, using identity even when metadata was rewritten. */
	messagePersisted(message: AgentMessage): void {
		const delivery = this.delivery;
		if (delivery?.message === message && delivery.phase !== "persisted") {
			delivery.phase = "persisted";
			if (delivery.completionId) delivery.service.markDelivered(delivery.completionId);
			else {
				const index = this.messages.findIndex((item) => item.id === delivery.id);
				if (index >= 0) this.messages.splice(index, 1);
			}
			delivery.queued?.resolve();
		}
		if (message.role === "toolResult") this.acknowledgeWait(message.toolCallId);
	}

	prepareWait(toolCallId: string, taskId: string): void {
		const service = this.service;
		const task = service.get(taskId);
		if (task.mode !== "background" || !isTaskTerminal(task.status)) return;
		this.waits.get(toolCallId)?.release();
		this.waits.set(toolCallId, { service, taskId, release: service.holdDelivery(taskId) });
	}

	private acknowledgeWait(toolCallId: string): void {
		const receipt = this.waits.get(toolCallId);
		if (!receipt) return;
		this.waits.delete(toolCallId);
		receipt.service.markDelivered(receipt.taskId);
		receipt.release();
	}

	private releaseWaits(): void {
		for (const receipt of this.waits.values()) receipt.release();
		this.waits.clear();
	}

	dispose(): void {
		this.disposed = true;
		this.messages.length = 0;
		this.releaseWaits();
		this.delivery?.queued?.reject(new Error("the session was disposed"));
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
