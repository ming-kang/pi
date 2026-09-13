/**
 * background — how a task is described, everywhere.
 *
 * Every output this extension produces (four tool actions, two notification
 * renderers, the /bg list and detail header) is the same thing: a BgTask
 * projected into a medium. The values those projections derive — runtime, exit
 * suffix, label, glyph — live here once, so the media can differ without the
 * vocabulary drifting. Pure functions; no TUI components, no theme.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { type StatusMarkerColor, statusMarker } from "../../modes/interactive/components/status-marker.ts";
import { firstCommandLine, formatDuration } from "./text.ts";
import type { BgTaskStatus } from "./types.ts";
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

/** Worker row label for listings: the "#1 explorer" ordinal label plus its description. */
export function workerLabel(worker: { label: string; description?: string }): string {
	return worker.description ? `${worker.label} — ${worker.description}` : worker.label;
}

/** A listing row's label, fitted to a visible-column budget. */
export function taskLabelWithin(task: { description?: string; command: string }, width: number): string {
	return truncateToWidth(taskLabel(task), width, "…");
}

/** First command line fitted to a visible-column budget — wide characters count as two. */
export function commandLabel(command: string, width: number): string {
	return truncateToWidth(firstCommandLine(command), width, "…");
}

/**
 * Static marker for transcripts and snapshots; the /bg panel animates running
 * rows via statusMarker(status, { now }) directly. Both delegate to the shared
 * status-marker vocabulary.
 */
export function statusGlyph(status: BgTaskStatus, stalled?: boolean): string {
	return statusMarker(status, { stalled }).glyph;
}

export function statusColor(status: BgTaskStatus, stalled?: boolean): StatusMarkerColor {
	return statusMarker(status, { stalled }).color;
}
