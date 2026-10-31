import { type Component, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface StickyUserMessageAnchor {
	/** Zero-based row of the first visible text line, excluding viewport padding. */
	readonly row: number;
	readonly summary: string;
}

export interface StickyUserMessageJudgment {
	readonly summary: string;
	readonly targetRow: number;
}

/** Select the nearest user message whose first line is above the viewport body. */
export function findStickyUserMessage(
	anchors: readonly StickyUserMessageAnchor[],
	bodyTop: number,
): StickyUserMessageJudgment | undefined {
	let low = 0;
	let high = anchors.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (anchors[middle]!.row < bodyTop) low = middle + 1;
		else high = middle;
	}

	// Landing exactly on any message's first line shows the original, not a duplicate pill.
	if (anchors[low]?.row === bodyTop || low === 0) return undefined;
	const anchor = anchors[low - 1]!;
	return { summary: anchor.summary, targetRow: anchor.row + 1 };
}

export class StickyUserMessageComponent implements Component {
	private judgment: StickyUserMessageJudgment | undefined;
	private readonly getOutputPad: () => number;
	private readonly scrollTo: (row: number) => void;

	constructor(getOutputPad: () => number, scrollTo: (row: number) => void) {
		this.getOutputPad = getOutputPad;
		this.scrollTo = scrollTo;
	}

	setJudgment(judgment: StickyUserMessageJudgment | undefined): boolean {
		if (this.judgment?.summary === judgment?.summary && this.judgment?.targetRow === judgment?.targetRow) {
			return false;
		}
		this.judgment = judgment;
		return true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.judgment || width <= 0) return [];
		const padding = " ".repeat(Math.max(0, Math.floor(this.getOutputPad())));
		const line = `${padding}${theme.fg("dim", "↑")} ${theme.fg("muted", this.judgment.summary)}`;
		return [truncateToWidth(line, width, "…")];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.type !== "click" ||
			event.button !== "left" ||
			event.shift ||
			event.alt ||
			event.ctrl ||
			(event.clickCount ?? 1) !== 1 ||
			!this.judgment
		) {
			return undefined;
		}
		this.scrollTo(this.judgment.targetRow);
		return { handled: true };
	}
}
