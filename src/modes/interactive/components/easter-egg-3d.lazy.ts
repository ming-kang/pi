import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import type { EasterEgg3d } from "./easter-egg-3d.ts";
import * as animation from "./easter-egg-3d.ts";

/**
 * Plays a 3D easter egg (see easter-egg-3d.ts). Only fullscreen mode can show it, because
 * it dissolves the rendered screen. Returns false when it cannot play.
 */
function playEasterEgg3d(tui: TUI, egg: EasterEgg3d): boolean {
	if (!(tui instanceof TuiAltScreen)) return false;
	if (tui.hasOverlay()) return true;
	const screen = tui.getScreenLines();
	void animation.playEasterEgg3d(tui, screen, egg);
	return true;
}

/** Plays the 3D pi logo, lifting off the header logo whose top-left cell is at `column`, `row`. */
export function playPiLogo3d(tui: TUI, column: number, row: number): void {
	playEasterEgg3d(tui, { kind: "pi-logo", column, row });
}

/** Plays the 3D Armin. Returns false when it cannot play, so the caller can fall back to the inline version. */
export function playArmin3d(tui: TUI): boolean {
	return playEasterEgg3d(tui, { kind: "armin" });
}
