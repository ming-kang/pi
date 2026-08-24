// Text utilities shared across the subagent extension: plain-text
// projection, UTF-8 byte bounding, and code-point truncation.

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

// Truncates by code points (never splitting a surrogate pair) and appends an
// ellipsis; for UTF-8 byte budgets use boundText instead.
export function truncate(text: string, limit: number): string {
	const characters = [...text];
	return characters.length <= limit ? text : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

// Iterates code points so a surrogate pair is never split in half.
export function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = "";
	let bytes = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		output += character;
		bytes += characterBytes;
	}
	return output;
}

export function boundText(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = utf8Prefix(text, maxBytes);
	for (let attempt = 0; attempt < 8; attempt++) {
		const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(output, "utf8");
		const notice = `\n\n[Output truncated: ${omitted} bytes omitted.]`;
		const available = maxBytes - Buffer.byteLength(notice, "utf8");
		if (available <= 0) return utf8Prefix("[Output truncated.]", maxBytes);
		const next = utf8Prefix(text, available);
		if (next === output) return `${output}${notice}`;
		output = next;
	}
	const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(output, "utf8");
	const notice = `\n\n[Output truncated: ${omitted} bytes omitted.]`;
	return `${utf8Prefix(output, Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8")))}${notice}`;
}
