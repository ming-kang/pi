import { isTaskTerminal, type TaskSnapshot, type TasksContext } from "../src/core/tasks/types.ts";

/**
 * Resolve once task `id` reaches a terminal status. Test-only helper; there is no
 * `tasks wait` action: production code never blocks on a task, since completions wake the model.
 */
export function settleTask(
	tasks: Pick<TasksContext, "get" | "subscribe">,
	id: string,
	timeoutMs = 10_000,
): Promise<{ outcome: "settled"; task: TaskSnapshot }> {
	return new Promise((resolve, reject) => {
		let unsubscribe = (): void => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`task ${id} did not settle within ${timeoutMs}ms`));
		}, timeoutMs);
		const check = (): boolean => {
			let task: TaskSnapshot;
			try {
				task = tasks.get(id);
			} catch (error) {
				clearTimeout(timer);
				unsubscribe();
				reject(error);
				return true;
			}
			if (!isTaskTerminal(task.status)) return false;
			clearTimeout(timer);
			unsubscribe();
			resolve({ outcome: "settled", task });
			return true;
		};
		if (check()) return;
		unsubscribe = tasks.subscribe(() => {
			check();
		});
	});
}
