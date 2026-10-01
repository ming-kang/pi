/** Compact elapsed time shared by tool responses and interactive views. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function runtimeLabel(task: { startedAt: number; endedAt?: number }, now = Date.now()): string {
	return formatDuration((task.endedAt ?? now) - task.startedAt);
}
