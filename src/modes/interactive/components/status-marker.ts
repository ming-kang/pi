/**
 * Shared status-marker vocabulary for long-running executions (background
 * tasks, subagent runs): one glyph+color mapping so the /bg panel, transcript
 * notifications, completion cards and subagent flows describe the same status
 * the same way. Pure data; consumers apply theme.fg(marker.color, glyph).
 *
 * Distinct from the tool-call chrome dot (warning/error/success ●), which
 * expresses call lifecycle, not task status.
 */

export type StatusMarkerColor = "success" | "error" | "warning" | "accent" | "muted";

export interface StatusMarker {
	glyph: string;
	color: StatusMarkerColor;
}

/**
 * A breathing dot-to-star bloom: the sequence plays forward to full bloom
 * and back, holding each extreme for two ticks. The mid frame uses ✼ rather
 * than the more common ✳ because U+2733 carries the Unicode Emoji property
 * and some terminals render it as a double-width color emoji.
 */
const SPINNER_BLOOM = ["·", "✢", "✼", "✶", "✻", "✽"];
export const STATUS_SPINNER_FRAMES: readonly string[] = [...SPINNER_BLOOM, ...[...SPINNER_BLOOM].reverse()];
export const STATUS_SPINNER_INTERVAL_MS = 120;

export function statusSpinnerFrame(now: number): string {
	const frame = Math.floor(now / STATUS_SPINNER_INTERVAL_MS) % STATUS_SPINNER_FRAMES.length;
	return STATUS_SPINNER_FRAMES[frame] ?? STATUS_SPINNER_FRAMES[0] ?? "·";
}

/**
 * Map an execution status to its marker. Pass `now` to animate a running
 * status as a spinner frame; without it running renders as the static `›`.
 * `stalled` (blocked on interactive input) wins over the underlying status.
 */
export function statusMarker(status: string, opts?: { stalled?: boolean; now?: number }): StatusMarker {
	if (opts?.stalled) return { glyph: "!", color: "warning" };
	switch (status) {
		case "running":
			return { glyph: opts?.now !== undefined ? statusSpinnerFrame(opts.now) : "›", color: "accent" };
		case "completed":
			return { glyph: "✓", color: "success" };
		case "failed":
			return { glyph: "×", color: "error" };
		case "timeout":
			return { glyph: "×", color: "warning" };
		case "cancelled":
		case "killed":
		case "stopping":
		case "partial":
		case "aborted":
			return { glyph: "○", color: "warning" };
		case "queued":
			return { glyph: "○", color: "muted" };
		default:
			return { glyph: "•", color: "muted" };
	}
}
