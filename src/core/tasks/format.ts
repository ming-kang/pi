import { formatDuration } from "../../utils/duration.ts";

export function runtimeLabel(task: { startedAt: number; endedAt?: number }, now = Date.now()): string {
	return formatDuration((task.endedAt ?? now) - task.startedAt);
}
