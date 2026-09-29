/**
 * Memoize rendered preview lines by (previewText, width) so editor keystrokes and
 * option scrolling don't re-parse the preview markdown on every frame. Questions
 * are immutable for a dialog's lifetime and carry few previews, so no eviction.
 */
export class PreviewLinesCache {
	private cache = new Map<string, Map<number, string[]>>();

	get(previewText: string, width: number, compute: () => string[]): string[] {
		let byWidth = this.cache.get(previewText);
		if (!byWidth) {
			byWidth = new Map();
			this.cache.set(previewText, byWidth);
		}
		let lines = byWidth.get(width);
		if (!lines) {
			lines = compute();
			byWidth.set(width, lines);
		}
		return lines;
	}
}

/** Cache custom dialog output by terminal dimensions. */
export class WidthCachedRender {
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private cachedHeight: number | undefined;

	invalidate(): void {
		this.cachedLines = undefined;
	}

	get(width: number, height: number, compute: (width: number, height: number) => string[]): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width && this.cachedHeight === height)
			return this.cachedLines;
		this.cachedLines = compute(width, height);
		this.cachedWidth = width;
		this.cachedHeight = height;
		return this.cachedLines;
	}
}
