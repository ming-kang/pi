import type { TUI } from "@earendil-works/pi-tui";

/** Minimal TUI surface for component tests: only render requests are observable. */
export function createFakeTui(requestRender: () => void = () => {}): TUI {
	return { requestRender } as unknown as TUI;
}
