import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessage } from "../messages.ts";
import { taskCompletionMessage } from "./presentation.ts";
import type { TaskRuntime } from "./runtime.ts";
import { isTaskTerminal } from "./types.ts";

export interface TaskDeliveryOptions {
	service(): TaskRuntime;
	canDeliver(): boolean;
	deliver(message: CustomMessage, waitForPersistence: () => Promise<void>): Promise<void>;
	warn(event: string, message: string): void;
}
interface Delivery {
	id: string;
	service: TaskRuntime;
	/** Agent-core preserves message identity; extension rewrites mutate it in place. */
	message: CustomMessage;
	phase: "pending" | "started" | "persisted";
	queued?: { resolve(): void; reject(reason: Error): void };
}

/** Result delivery is independent of execution handles and retained output. */
export class TaskDelivery {
	private readonly options: TaskDeliveryOptions;
	private disposed = false;
	private pauses = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private delivery?: Delivery;
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
		this.failures.clear();
		this.schedule();
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

	private canDeliver(service: TaskRuntime): boolean {
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
		if (!task) return;
		const message = taskCompletionMessage(task);
		if (!service.claimNotification(task.id)) return;
		// Exactly one completion may be in flight, whether queued for steering or running its
		// own turn; there is no separate claim registry.
		const delivery: Delivery = {
			id: task.id,
			service,
			message,
			phase: "pending",
		};
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
				service.releaseNotification(task.id);
				if (service === this.service) this.failures.add(task.id);
				const reason = deliveryError instanceof Error ? `: ${deliveryError.message}` : "";
				this.warn(
					"task_delivery",
					`Background completion delivery failed for ${task.id}${reason}; it will retry on the next input.`,
				);
			}
			this.delivery = undefined;
			const current = this.service;
			if (this.canDeliver(current) && current.pendingNotifications().some((task) => !this.failures.has(task.id)))
				this.schedule();
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
			delivery.queued?.reject(new Error("the completion message was not persisted"));
		}
	}

	queueCleared(): void {
		this.delivery?.queued?.reject(new Error("the completion message was dequeued before delivery"));
	}

	/** Acknowledge only successful appends, using identity even when metadata was rewritten. */
	messagePersisted(message: AgentMessage): void {
		const delivery = this.delivery;
		if (delivery?.message === message && delivery.phase !== "persisted") {
			delivery.phase = "persisted";
			delivery.service.markDelivered(delivery.id);
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
		this.releaseWaits();
		this.delivery?.queued?.reject(new Error("the session was disposed"));
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
