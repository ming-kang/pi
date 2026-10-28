import { formatDuration } from "../../core/tasks/format.ts";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatRunSummary(startedAt: number, finishedAt: number, outcome: "done" | "stopped" = "done"): string {
	const done = new Date(finishedAt);
	const timestamp = `${done.getFullYear()}/${pad(done.getMonth() + 1)}/${pad(done.getDate())} ${pad(done.getHours())}:${pad(done.getMinutes())}`;
	const label = outcome === "done" ? "Done" : "Stopped";
	return `Worked for ${formatDuration(finishedAt - startedAt)} · ${label} ${timestamp}`;
}
