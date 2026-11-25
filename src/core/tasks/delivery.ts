import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessage } from "../messages.ts";
import { taskCompletionMessage } from "./presentation.ts";
import type { TaskSnapshot, TasksContext } from "./types.ts";

/** All the delivery policy needs from a runtime: its public, session-independent surface. */
export type TaskDeliveryService = Pick<TasksContext, "enabled" | "closed" | "list" | "retain">;

export const MAX_DELIVERY_BATCH_MESSAGES = 8;
export const MAX_DELIVERY_BATCH_BYTES = 96 * 1024;

export interface TaskDeliveryOptions {
	service(): TaskDeliveryService;
	canDeliver(): boolean;
	deliver(message: CustomMessage, waitForPersistence: () => Promise<void>): Promise<void>;
	/** When set, ready completions coalesce up to `maxBatchSize()` and `MAX_DELIVERY_BATCH_BYTES`. */
	deliverBatch?(messages: CustomMessage[], waitForPersistence: () => Promise<void>): Promise<void>;
	/** Defaults to `MAX_DELIVERY_BATCH_MESSAGES` when `deliverBatch` is set, else 1. */
	maxBatchSize?(): number;
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

interface DeliveryItem {
	id: string;
	completion: Completion;
	/** Agent-core preserves message identity; extension rewrites mutate it in place. */
	message: CustomMessage;
	phase: "pending" | "started" | "persisted";
}

interface Delivery {
	items: DeliveryItem[];
	queued?: { resolve(): void; reject(reason: Error): void };
	rejected?: Error;
}

function messageContentBytes(message: CustomMessage): number {
	if (typeof message.content === "string") return Buffer.byteLength(message.content);
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") total += Buffer.byteLength(block.text);
	}
	return total;
}

/**
 * Sole owner of "has this completion reached the model": the pending queue, claims, the in-flight
 * completion batch, failures and pauses. An undelivered completion is
 * a retention lease on its task, so the runtime keeps the record and its output exactly as long
 * as delivery needs them, and a bare runtime carries no delivery concept at all.
 */
export class TaskDelivery {
	private readonly options: TaskDeliveryOptions;
	private disposed = false;
	private pauses = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private delivery?: Delivery;
	/** Undelivered completion leases keyed by task ID; `pending()` orders delivery by launch order. */
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
		this.schedule(true);
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
		this.failures.delete(taskId);
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
			this.failures.delete(id);
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
		if (service.closed || this.completions.size === 0) return [];
		return service.list().filter((task) => {
			const completion = this.completions.get(task.id);
			return completion?.service === service && !completion.claimed;
		});
	}

	schedule(force = false): void {
		if (this.disposed || this.timer || this.delivery || (!force && this.completions.size === 0)) return;
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

	private selectBatch(candidates: TaskSnapshot[]): DeliveryItem[] {
		const maxMessages = this.options.deliverBatch
			? Math.max(
					1,
					Math.min(MAX_DELIVERY_BATCH_MESSAGES, this.options.maxBatchSize?.() ?? MAX_DELIVERY_BATCH_MESSAGES),
				)
			: 1;
		const items: DeliveryItem[] = [];
		let totalBytes = 0;
		for (const task of candidates) {
			if (items.length >= maxMessages) break;
			const message = taskCompletionMessage(task);
			const size = messageContentBytes(message);
			if (items.length > 0 && totalBytes + size > MAX_DELIVERY_BATCH_BYTES) break;
			items.push({
				id: task.id,
				completion: this.completions.get(task.id)!,
				message,
				phase: "pending",
			});
			totalBytes += size;
		}
		return items;
	}

	private async drain(): Promise<void> {
		const service = this.service;
		if (this.delivery || !this.canDeliver(service)) return;
		if (this.failures.size) {
			const retained = new Set(service.list().map((task) => task.id));
			for (const id of this.failures) if (!retained.has(id)) this.failures.delete(id);
		}
		const candidates = this.pending().filter((task) => !this.failures.has(task.id));
		if (candidates.length === 0) return;
		const items = this.selectBatch(candidates);
		for (const item of items) item.completion.claimed = true;
		// Exactly one completion batch may be in flight, whether queued for steering or running its
		// own turn; there is no separate claim registry.
		const delivery: Delivery = { items };
		this.delivery = delivery;
		const waitForPersistence = () =>
			new Promise<void>((resolve, reject) => {
				if (delivery.items.every((item) => item.phase === "persisted")) resolve();
				else if (delivery.rejected) reject(delivery.rejected);
				else delivery.queued = { resolve, reject };
			});
		let deliveryError: unknown;
		try {
			if (this.options.deliverBatch) {
				await this.options.deliverBatch(
					items.map((item) => item.message),
					waitForPersistence,
				);
			} else {
				await this.options.deliver(items[0]!.message, waitForPersistence);
			}
		} catch (error) {
			deliveryError = error;
		} finally {
			for (const item of delivery.items) {
				if (item.phase !== "persisted") {
					item.completion.claimed = false;
					if (service === this.service) this.failures.add(item.id);
					const reason = deliveryError instanceof Error ? `: ${deliveryError.message}` : "";
					this.warn(
						"task_delivery",
						`Background completion delivery failed for ${item.id}${reason}; it will retry on the next input.`,
					);
				}
			}
			this.delivery = undefined;
			if (this.canDeliver(this.service) && this.pending().some((task) => !this.failures.has(task.id)))
				this.schedule();
			this.changed();
		}
	}

	/** Record dequeueing before message hooks can fail or rewrite the notification. */
	messageStarted(message: AgentMessage): void {
		const item = this.delivery?.items.find((entry) => entry.message === message);
		if (item && item.phase === "pending") item.phase = "started";
	}

	/** A queued message that was never emitted remains claimed for the next run. */
	agentEnded(): void {
		const delivery = this.delivery;
		if (delivery?.items.some((entry) => entry.phase === "started")) {
			const error = new Error("the completion message was not persisted");
			delivery.rejected ??= error;
			delivery.queued?.reject(error);
		}
	}

	queueCleared(): void {
		const delivery = this.delivery;
		if (!delivery) return;
		const error = new Error("the completion message was dequeued before delivery");
		delivery.rejected ??= error;
		delivery.queued?.reject(error);
	}

	/** Acknowledge only successful appends, using identity even when metadata was rewritten. */
	messagePersisted(message: AgentMessage): void {
		const delivery = this.delivery;
		const item = delivery?.items.find((entry) => entry.message === message);
		if (!delivery || !item || item.phase === "persisted") return;
		item.phase = "persisted";
		this.acknowledge(item.id);
		if (delivery.items.every((entry) => entry.phase === "persisted")) {
			delivery.queued?.resolve();
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const completion of this.completions.values()) completion.release();
		this.completions.clear();
		this.failures.clear();
		this.delivery?.queued?.reject(new Error("the session was disposed"));
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.changed();
		this.listeners.clear();
	}
}
