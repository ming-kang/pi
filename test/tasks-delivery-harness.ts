import type { AgentSession } from "../src/core/agent-session.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { TaskDelivery } from "../src/core/tasks/delivery.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskSession } from "../src/core/tasks/session.ts";
import type { TaskRuntimeOptions, TaskSnapshot } from "../src/core/tasks/types.ts";

interface DeliveryHarnessOptions extends TaskRuntimeOptions {
	/** Whether the host can start a delivery now. Defaults to never, so completions stay pending. */
	canDeliver?: () => boolean;
	/** The host's delivery action. Defaults to persisting the message at once. */
	deliver?: (message: CustomMessage, waitForPersistence: () => Promise<void>) => Promise<void>;
}

/**
 * A runtime wired to a TaskDelivery the way TaskSession wires them, without a session journal:
 * a handed-off task that settles is enqueued, and a closed
 * runtime releases its leases. `pending()` is what the delivery would notify the model about next.
 */
export function createDeliveryHarness(options: DeliveryHarnessOptions = {}) {
	const { canDeliver, deliver, onSettled, ...runtimeOptions } = options;
	const delivered: CustomMessage[] = [];
	const warnings: string[] = [];
	const delivery: TaskDelivery = new TaskDelivery({
		service: () => runtime,
		canDeliver: canDeliver ?? (() => false),
		deliver:
			deliver ??
			(async (message) => {
				delivered.push(message);
				delivery.messageStarted(message);
				delivery.messagePersisted(message);
			}),
		warn: (_event, message) => warnings.push(message),
	});
	const runtime: TaskRuntime = new TaskRuntime({
		enabled: true,
		...runtimeOptions,
		onSettled: (task, usage) => {
			try {
				onSettled?.(task, usage);
			} finally {
				if (task.mode === "background") delivery.enqueue(runtime, task.id);
			}
		},
		onClosed: () => delivery.discard(runtime),
	});
	if (canDeliver) runtime.subscribe(() => delivery.schedule());
	return {
		runtime,
		delivery,
		delivered,
		warnings,
		pending: (): TaskSnapshot[] => delivery.pending(),
		dispose: () => {
			runtime.close();
			delivery.dispose();
		},
	};
}

/**
 * The session's delivery owner, for tests that must tell "queued for the model" from "delivered".
 * There is deliberately no public accessor: hosts observe delivery through messages.
 */
export function sessionDelivery(session: AgentSession): TaskDelivery {
	return (session as unknown as { _tasksHost: TaskSession })._tasksHost.delivery;
}
