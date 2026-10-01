/** Human-facing status and labels shared by task views and historical transcript renderers. */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TasksTaskStatus } from "../../../core/tools/tasks/types.ts";
import { type StatusMarkerColor, statusMarker } from "../components/status-marker.ts";
import { firstCommandLine } from "./text.ts";

export function statusName(status: string): string {
	return status === "timeout" ? "Timed out" : status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown";
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

/** Label for listings: the context-provided description over the first command line. */
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
 * Static marker for transcripts and snapshots; the /tasks panel animates running
 * rows via statusMarker(status, { now }) directly. Both delegate to the shared
 * status-marker vocabulary.
 */
export function statusGlyph(status: TasksTaskStatus, stalled?: boolean): string {
	return statusMarker(status, { stalled }).glyph;
}

export function statusColor(status: TasksTaskStatus, stalled?: boolean): StatusMarkerColor {
	return statusMarker(status, { stalled }).color;
}
