/** Human-facing status labels shared by the /tasks panel and transcript renderers. */

import type { TaskStatus } from "../../../core/tasks/types.ts";
import { type StatusMarkerColor, statusMarker } from "../../../modes/interactive/components/status-marker.ts";

export function statusName(status: string): string {
	return status === "timeout" ? "Timed out" : status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown";
}

/** Static marker for transcripts; the /tasks panel animates running rows via statusMarker(status, { now }). */
export function statusGlyph(status: TaskStatus): string {
	return statusMarker(status).glyph;
}

export function statusColor(status: TaskStatus): StatusMarkerColor {
	return statusMarker(status).color;
}
