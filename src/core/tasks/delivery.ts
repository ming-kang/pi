import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessage } from "../messages.ts";
import { taskCompletionMessage } from "./presentation.ts";
import type { TaskSnapshot, TasksContext } from "./types.ts";

/** All the delivery policy needs from a runtime: its public, session-independent surface. */
export type TaskDeliveryService = Pick<TasksContext, "enabled" | "closed" | "list" | "retain">;

export interface TaskDeliveryOptions {
	service(): TaskDeliveryService;
	canDeliver(): boolean;
	deliver(message: CustomMessage, waitForPersistence: () => Promise<void>): Promise<void>;
	warn(event: string, message: string): void;
}

/** A settled handoff the model has not yet seen, kept retained by a lease until it has. */
interface Completion {
	service: TaskDeliveryService;
	/** The retention lease: the record and its output stay available until delivery or acknowledgement. */
	release(): void;
	/** Handed to the host and awaiting persistence. */
	claimed: boolean;
}

interface Delivery {
	id: string;
	/** Agent-core preserves message identity; extension rewrites mutate it in place. */
	message: CustomMessage;
	phase: "pending" | "started" | "persisted";
	queued?: { resolve(): void; reject(reason: Error): void };
}

/**
 * Sole owner of "has this completion reached the model": the pending queue, claims, the in-flight
 * completion, failures and pauses. An undelivered completion is
 * a retention lease on its task, so the runtime keeps the record and its output exactly as long
 * as delivery needs them, and a bare runtime carries no delivery concept at all.
 */
export class TaskDelivery {
	private readonly options: TaskDeliveryOptions;
	private disposed = false;
	private pauses = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private delivery?: Delivery;
	/** Settlement order. */
	private readonly completions = new Map<string, Completion>();
	private readonly failures = new Set<string>();
	private readonly listeners = new Set<() => void>();
	constructor(options: TaskDeliveryOptions) {
		this.options = options;
	}
	private get service(): TaskDeliveryService {
		return this.options.service();
	}
	private warn(event: string, message: string): void {
		this.options.warn(event, message);
	}
	/** Called whenever what `hasDeliverableWork()` reads may have changed. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// Observers cannot interrupt delivery.
			}
		}
	}

	/**
	 * Whether a completion is in flight or will be delivered without further input: queued on the
	 * current runtime, visible on the branch and not failed. A failed delivery only retries on the
	 * next input, so it does not count.
	 */
	hasDeliverableWork(): boolean {
		if (this.disposed) return false;
		const service = this.service;
		if (service.closed) return false;
		if (this.delivery) return true;
		if (!service.enabled || this.completions.size === 0) return false;
		return service.list().some((task) => {
			const completion = this.completions.get(task.id);
			return completion?.service === service && !this.failures.has(task.id);
		});
	}

	/** Nestable across asynchronous preflight and service replacement. */
	pause(): () => void {
		this.pauses++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.pauses--;
			this.schedule();
		};
	}

	retry(): void {
		this.failures.clear();
		this.schedule();
		this.changed();
	}

	/** A handed-off task settled on `service`; it awaits automatic delivery under a retention lease. */
	enqueue(service: TaskDeliveryService, taskId: string): void {
		if (this.disposed || service.closed || this.completions.has(taskId)) return;
		this.completions.set(taskId, { service, release: service.retain(taskId), claimed: false });
		this.schedule();
		this.changed();
	}

	/** The model has the result (or the host consumed it): stop waiting to deliver and release the lease. */
	acknowledge(taskId: string): void {
		const completion = this.completions.get(taskId);
		if (!completion) return;
		this.completions.delete(taskId);
		completion.release();
		this.changed();
	}

	/** Release every lease held for a runtime that closed or was replaced, so its output cleanup can run. */
	discard(service: TaskDeliveryService): void {
		for (const [id, completion] of [...this.completions]) {
			if (completion.service !== service) continue;
			this.completions.delete(id);
			completion.release();
		}
		this.changed();
	}

	/**
	 * Completions that would be delivered next, oldest launch first: on the visible branch and not
	 * claimed. Failed deliveries stay listed until the next retry.
	 */
	pending(): TaskSnapshot[] {
		const service = this.service;
		if (service.closed) return [];
		return service.list().filter((task) => {
			const completion = this.completions.get(task.id);
			return completion?.service === service && !completion.claimed;
		});
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

	private canDeliver(service: TaskDeliveryService): boolean {
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
		const task = this.pending().find((task) => !this.failures.has(task.id));
		if (!task) return;
		const completion = this.completions.get(task.id)!;
		const message = taskCompletionMessage(task);
		completion.claimed = true;
		// Exactly one completion may be in flight, whether queued for steering or running its
		// own turn; there is no separate claim registry.
		const delivery: Delivery = {
			id: task.id,
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
				completion.claimed = false;
				if (service === this.service) this.failures.add(task.id);
				const reason = deliveryError instanceof Error ? `: ${deliveryError.message}` : "";
				this.warn(
					"task_delivery",
					`Background completion delivery failed for ${task.id}${reason}; it will retry on the next input.`,
				);
			}
			this.delivery = undefined;
			if (this.canDeliver(this.service) && this.pending().some((task) => !this.failures.has(task.id)))
				this.schedule();
			this.changed();
		}
	}

	/** Record dequeueing before message hooks can fail or rewrite the notification. */
	messageStarted(message: AgentMessage): void {
		const delivery = this.delivery;
		if (delivery?.message === message && delivery.phase === "pending") delivery.phase = "started";
	}

	/** A queued message that was never emitted remains claimed for the next run. */
	agentEnded(): void {
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
			this.acknowledge(delivery.id);
			delivery.queued?.resolve();
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const completion of this.completions.values()) completion.release();
		this.completions.clear();
		this.delivery?.queued?.reject(new Error("the session was disposed"));
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.changed();
		this.listeners.clear();
	}
}
