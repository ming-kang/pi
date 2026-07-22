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
