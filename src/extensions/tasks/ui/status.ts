/** The one status vocabulary for every task renderer: panel, transcript rows and completion cards. */

import type { TaskMode, TaskStatus } from "../../../core/tasks/types.ts";
import { type StatusMarkerColor, statusMarker } from "../../../modes/interactive/components/status-marker.ts";

export interface StatusView {
	name: string;
	glyph: string;
	color: StatusMarkerColor;
}

function capitalize(word: string): string {
	return word ? word[0]!.toUpperCase() + word.slice(1) : "Unknown";
}

export function statusName(status: TaskStatus): string {
	return status === "timeout" ? "Timed out" : capitalize(status);
}

export function modeName(mode: TaskMode): string {
	return capitalize(mode);
}

/** Name, glyph and color of a status. Pass `now` to animate a running status as a spinner frame. */
export function statusView(status: TaskStatus, options?: { now?: number }): StatusView {
	return { name: statusName(status), ...statusMarker(status, options) };
}
