/**
 * Memoize rendered preview lines by (previewText, width, maxLines) so editor
 * keystrokes don't re-parse the preview markdown on every frame. Questions are
 * immutable for a dialog's lifetime and carry few previews, so no eviction.
 */
export class PreviewLinesCache {
	private cache = new Map<string, Map<string, string[]>>();

	get(previewText: string, width: number, maxLines: number, compute: () => string[]): string[] {
		let byDimensions = this.cache.get(previewText);
		if (!byDimensions) {
			byDimensions = new Map();
			this.cache.set(previewText, byDimensions);
		}
		const key = `${width}x${maxLines}`;
		let lines = byDimensions.get(key);
		if (!lines) {
			lines = compute();
			byDimensions.set(key, lines);
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
