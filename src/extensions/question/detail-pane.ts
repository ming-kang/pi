import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

/**
 * A separately paged reading area; changing the choice starts at its beginning.
 * Pages are applied at the next render, where the content height is known, so a
 * page key that arrives before a redraw still scrolls the content it was meant for.
 */
export class DetailPane {
	private key = "";
	private offset = 0;
	private maxOffset = 0;
	private pageRows = 1;
	private pendingPages = 0;

	reset(): void {
		this.key = "";
		this.offset = 0;
		this.maxOffset = 0;
		this.pendingPages = 0;
	}

	page(key: string, direction: -1 | 1): void {
		if (this.key !== key) this.reset();
		this.key = key;
		this.pendingPages += direction;
	}

	render(
		key: string,
		title: string,
		content: string[],
		width: number,
		rows: number,
		scrollHint: string,
		theme: Theme,
	): string[] {
		if (this.key !== key) {
			this.reset();
			this.key = key;
		}
		const bodyRows = Math.max(1, rows - 2);
		const wasAtEnd = this.maxOffset > 0 && this.offset === this.maxOffset;
		this.maxOffset = Math.max(0, content.length - bodyRows);
		// Keep one overlapping line when paging so code and paragraphs remain easy to follow.
		this.pageRows = Math.max(1, bodyRows - 1);
		const anchored = wasAtEnd ? this.maxOffset : this.offset;
		this.offset = Math.max(0, Math.min(this.maxOffset, anchored + this.pendingPages * this.pageRows));
		this.pendingPages = 0;
		const body = content.slice(this.offset, this.offset + bodyRows);
		if (rows < 3) return body.slice(0, rows);
		const lines = [theme.fg("muted", truncateToWidth(` ${title.replace(/\s+/gu, " ")}`, width)), ...body];
		if (this.maxOffset > 0) {
			while (lines.length < rows - 1) lines.push("");
			const range = `${this.offset + 1}–${this.offset + body.length}/${content.length}`;
			lines.push(theme.fg("dim", truncateToWidth(` ${range}${scrollHint ? ` • ${scrollHint}` : ""}`, width)));
		}
		return lines;
	}
}
