import tasksExtension from "../src/extensions/tasks/index.ts";

/** Drive the real bundled extension with the existing event fixtures. */
export function createTasksHarness() {
	return tasksExtension;
}
