import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

/** A separately paged reading area; changing the choice starts at its beginning. */
export class DetailPane {
	private key = "";
	private offset = 0;
	private maxOffset = 0;
	private pageRows = 1;

	reset(): void {
		this.key = "";
		this.offset = 0;
		this.maxOffset = 0;
	}

	page(direction: -1 | 1): void {
		this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + direction * this.pageRows));
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
			this.key = key;
			this.offset = 0;
		}
		const bodyRows = Math.max(1, rows - 2);
		const wasAtEnd = this.maxOffset > 0 && this.offset === this.maxOffset;
		this.maxOffset = Math.max(0, content.length - bodyRows);
		this.offset = wasAtEnd ? this.maxOffset : Math.min(this.offset, this.maxOffset);
		// Keep one overlapping line when paging so code and paragraphs remain easy to follow.
		this.pageRows = Math.max(1, bodyRows - 1);
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
