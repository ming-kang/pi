import type { TuiMouseEvent } from "@earendil-works/pi-tui";

/**
 * Only an unmodified single primary click belongs to a local toggle action.
 * Modifier chords (terminal selection, host shortcuts) and later clicks of a
 * multi-click sequence pass through to selection, scrolling, or host logic.
 */
export function isPlainPrimaryClick(event: TuiMouseEvent): boolean {
	return (
		event.type === "click" &&
		event.button === "left" &&
		!event.shift &&
		!event.alt &&
		!event.ctrl &&
		(event.clickCount ?? 1) === 1
	);
}
