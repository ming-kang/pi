import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface Entry {
	text: string;
	line: number;
	column: number;
}

/** Independent scroll state for each region, with a source-line anchor for resize. */
export class TaskViewport {
	follow: boolean;
	private scroll = 0;
	private anchor?: { line: number; column: number };
	private entries: Entry[] = [];
	private wrapped?: { lines: string[]; width: number };
	private height = 1;
	private start = 0;
	constructor(follow = false) {
		this.follow = follow;
	}
	layout(lines: string[], width: number, height: number): string[] {
		this.height = Math.max(1, height);
		// Output can be 48 KiB; rewrap only when its lines or the width change, not per animation frame.
		if (lines !== this.wrapped?.lines || width !== this.wrapped.width) {
			this.wrapped = { lines, width };
			this.entries = lines.flatMap((line, index) => {
				let column = 0;
				return wrapTextWithAnsi(line, Math.max(1, width)).map((text) => {
					const entry = { text, line: index, column };
					column += visibleWidth(text);
					return entry;
				});
			});
		}
		let offset = this.scroll;
		if (this.anchor) {
			const anchor = this.anchor;
			const first = this.entries.findIndex((entry) => entry.line === anchor.line);
			if (first >= 0) {
				offset = first;
				while (
					offset + 1 < this.entries.length &&
					this.entries[offset + 1]!.line === anchor.line &&
					this.entries[offset + 1]!.column <= anchor.column
				)
					offset++;
			}
		}
		this.start = this.follow ? this.max : Math.min(offset, this.max);
		return this.entries.slice(this.start, this.start + this.height).map((entry) => entry.text);
	}
	private get max(): number {
		return Math.max(0, this.entries.length - this.height);
	}
	move(direction: number, page: boolean, tail: boolean): void {
		this.scroll = Math.max(0, Math.min(this.max, this.start + direction * (page ? this.height : 1)));
		const entry = this.entries[this.scroll];
		this.anchor = entry ? { line: entry.line, column: entry.column } : undefined;
		this.follow = tail && direction > 0 && this.scroll === this.max;
	}
	jump(bottom: boolean, tail: boolean): void {
		this.scroll = bottom ? this.max : 0;
		const entry = this.entries[this.scroll];
		this.anchor = entry ? { line: entry.line, column: entry.column } : undefined;
		this.follow = bottom && tail;
	}
	get range(): string {
		return `${this.entries.length ? this.start + 1 : 0}–${Math.min(this.start + this.height, this.entries.length)}/${this.entries.length}`;
	}
}
