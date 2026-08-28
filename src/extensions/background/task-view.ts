/**
 * background — how a task is described, everywhere.
 *
 * Every output this extension produces (five tool results, two notifications,
 * the statusline, the /bg list and detail header) is the same thing: a BgTask
 * projected into a medium. The values those projections derive — runtime, exit
 * suffix, label, glyph — live here once, so the media can differ without the
 * vocabulary drifting. Pure functions; no TUI components, no theme.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { BgTaskStatus } from "./registry.ts";
import { firstCommandLine, formatDuration } from "./text.ts";
/** How long a task has run, or ran. A running task has no `endedAt`, so it measures to `now`. */
export function runtimeMs(task: { startedAt: number; endedAt?: number }, now = Date.now()): number {
	return (task.endedAt ?? now) - task.startedAt;
}

export function runtimeLabel(task: { startedAt: number; endedAt?: number }, now = Date.now()): string {
	return formatDuration(runtimeMs(task, now));
}

/**
 * Whether a task produced an exit code. Three-state by necessity: `undefined`
 * while running or when the run produced none, `null` when reaped by a signal —
 * and historical session entries still hold `null`, so this must keep accepting it.
 */
export function hasExitCode(exitCode: number | null | undefined): exitCode is number {
	return exitCode !== undefined && exitCode !== null;
}

/** `<separator>exit <code>`, or nothing. Callers pick the separator: " ", ", ", " · ". */
export function exitSuffix(exitCode: number | null | undefined, separator: string): string {
	return hasExitCode(exitCode) ? `${separator}exit ${exitCode}` : "";
}

/** Label for listings: the model-provided description over the first command line. */
export function taskLabel(task: { description?: string; command: string }): string {
	const command = firstCommandLine(task.command);
	return task.description ? `${task.description} — ${command}` : command;
}

/** A listing row's label, fitted to a visible-column budget. */
export function taskLabelWithin(task: { description?: string; command: string }, width: number): string {
	return truncateToWidth(taskLabel(task), width, "…");
}

/** First command line fitted to a visible-column budget — wide characters count as two. */
export function commandLabel(command: string, width: number): string {
	return truncateToWidth(firstCommandLine(command), width, "…");
}

export function statusGlyph(status: BgTaskStatus, stalled?: boolean): string {
	if (stalled) return "…";
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
		case "timeout":
			return "✗";
		case "killed":
			return "○";
		default:
			return "●";
	}
}

export function statusColor(status: BgTaskStatus, stalled?: boolean): "success" | "error" | "warning" | "accent" {
	if (stalled) return "warning";
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "timeout":
		case "killed":
			return "warning";
		default:
			return "accent";
	}
}

/** The footer segment, or nothing when this session has no tasks at all. */
export function formatStatusline(counts: { running: number; total: number; stalled: number }): string | undefined {
	if (counts.total === 0) return undefined;
	// Stalled tasks are running tasks: report them separately so the counts add up.
	const running = counts.running - counts.stalled;
	const ended = counts.total - counts.running;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (counts.stalled > 0) parts.push(`${counts.stalled} waiting for input`);
	if (ended > 0) parts.push(`${ended} done`);
	return `bg ${parts.join(" · ")}`;
}
