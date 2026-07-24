import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { runLine } from "./render.ts";
import type { SubagentDetails, SubagentRunDetails } from "./types.ts";

const WIDGET_KEY = "subagents";
const MAX_ROWS = 6;
const TICK_MS = 1_000;

/**
 * Live panel above the editor mirroring every in-flight subagent call.
 * Rows reuse the transcript run line so both surfaces stay in sync; a
 * ticker keeps elapsed time moving between progress updates.
 */
export class SubagentWidget {
	private readonly calls = new Map<string, SubagentDetails>();
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private ticker: ReturnType<typeof setInterval> | undefined;

	update(ui: ExtensionUIContext, toolCallId: string, details: SubagentDetails): void {
		this.ui = ui;
		this.calls.set(toolCallId, details);
		this.sync();
	}

	finish(toolCallId: string): void {
		if (!this.calls.delete(toolCallId)) return;
		this.sync();
	}

	dispose(): void {
		this.calls.clear();
		this.stopTicker();
		if (this.registered) this.ui?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.ui = undefined;
	}

	// Register/unregister based on state, never as a render side effect.
	private sync(): void {
		if (!this.ui) return;
		if (this.calls.size === 0) {
			this.stopTicker();
			if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
			this.tui = undefined;
			return;
		}
		if (this.registered) {
			this.tui?.requestRender();
		} else {
			this.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.render(theme, width),
						invalidate: () => {
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		}
		this.startTicker();
	}

	private startTicker(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.tui?.requestRender(), TICK_MS);
	}

	private stopTicker(): void {
		if (this.ticker === undefined) return;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private render(theme: Theme, _width: number): string[] {
		const entries: Array<{ run: SubagentRunDetails; mode: SubagentDetails["mode"] }> = [];
		for (const details of this.calls.values()) {
			for (const run of details.runs) entries.push({ run, mode: details.mode });
		}
		const active = entries.filter(({ run }) => run.status === "running" || run.status === "queued");
		const settled = entries.filter(({ run }) => run.status !== "running" && run.status !== "queued");
		const shown = [...active, ...settled].slice(0, MAX_ROWS);
		const now = Date.now();
		const lines = shown.map(({ run, mode }) => runLine(run, theme, mode, now));
		const hidden = entries.length - shown.length;
		if (hidden > 0) lines.push(theme.fg("muted", `+${hidden} more`));
		return lines;
	}
}
