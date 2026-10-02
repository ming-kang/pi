import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import * as animation from "./pi-logo-animation.ts";

/**
 * Plays the logo easter egg (see pi-logo-animation.ts) on a click. Only fullscreen mode can show it,
 * because it dissolves the rendered screen.
 */
export function playPiLogoAnimation(tui: TUI, logoColumn: number, logoRow: number): void {
	if (!(tui instanceof TuiAltScreen) || tui.hasOverlay()) return;
	void animation.playPiLogoAnimation(tui, { screen: tui.getScreenLines(), logoColumn, logoRow });
}
