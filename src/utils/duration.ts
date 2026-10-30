/** Compact elapsed time shared by tool responses and interactive views. */
export function formatDuration(ms: number): string {
	if (ms < 500) return "<1s";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const remainder = seconds % 60;
		return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
