export interface TruncateTextOptions {
	ellipsis?: string;
	collapseWhitespace?: boolean;
}

export function truncateText(text: string, maxLength: number, options: TruncateTextOptions = {}): string {
	const ellipsis = options.ellipsis ?? "...";
	const source = options.collapseWhitespace ? text.replace(/\s+/g, " ").trim() : text;
	if (source.length <= maxLength) return source;
	if (ellipsis.length >= maxLength) return ellipsis.slice(0, maxLength);
	return `${source.slice(0, maxLength - ellipsis.length)}${ellipsis}`;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
