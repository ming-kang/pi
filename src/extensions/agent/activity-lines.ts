/** Agent argument adaptation for the shared structured task-activity renderer. */
import { taskActivityLines } from "../../modes/interactive/components/task-activity-list.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { targetOf } from "./activity.ts";
import type { AgentActivity } from "./types.ts";

/** Transcript details retain bounded arguments for older snapshots; derive their target before rendering. */
export function activityLines(
	activities: readonly AgentActivity[],
	width: number,
	theme: Theme,
	now = Date.now(),
): string[] {
	return taskActivityLines(
		activities.map((activity) => ({ ...activity, target: targetOf(activity) })),
		width,
		theme,
		0,
		now,
	);
}
