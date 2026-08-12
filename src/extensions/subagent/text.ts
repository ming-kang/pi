export function plainLine(text: string): string {
	return text
		.replace(/^\s*#{1,6}\s+/u, "")
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/\*\*([^*]+)\*\*/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/\s+/gu, " ")
		.trim();
}

export function firstPlainLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => plainLine(line))
			.find(Boolean) ?? ""
	);
}
