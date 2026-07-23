const SHELL_KEYWORDS = new Set([
	"case",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"until",
	"while",
]);

type CommandSeparator = "&&" | "||" | "|" | "|&" | ";" | "\n";

function splitTopLevelCommands(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let sawSeparator = false;
	let trailingSeparator: CommandSeparator | undefined;

	const pushSegment = (separator: CommandSeparator): boolean => {
		const segment = current.trim();
		if (!segment) return false;
		segments.push(segment);
		current = "";
		sawSeparator = true;
		trailingSeparator = separator;
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			if (char !== "\n") current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			if (next === "\n") {
				i++;
				continue;
			}
			escaped = true;
			current += char;
			continue;
		}

		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}

		if (char === "`" || (char === "$" && (next === "(" || next === "{"))) {
			return undefined;
		}

		// Redirections, grouping, comments, and background execution need more
		// shell grammar than a display-only summary should attempt to model.
		if (char === "<" || char === ">" || char === "(" || char === ")" || char === "#") {
			return undefined;
		}

		if (char === "&") {
			if (next !== "&") return undefined;
			if (!pushSegment("&&")) return undefined;
			current = "";
			i++;
			continue;
		}

		if (char === "|") {
			if (next === "|") {
				if (!pushSegment("||")) return undefined;
				i++;
			} else if (next === "&") {
				if (!pushSegment("|&")) return undefined;
				i++;
			} else if (!pushSegment("|")) {
				return undefined;
			}
			current = "";
			continue;
		}

		if (char === ";") {
			if (next === ";" || next === "&") return undefined;
			if (!pushSegment(";")) return undefined;
			current = "";
			continue;
		}

		if (char === "\n") {
			if (!current.trim() && trailingSeparator && trailingSeparator !== ";" && trailingSeparator !== "\n") {
				continue;
			}
			if (!pushSegment("\n")) return undefined;
			current = "";
			continue;
		}

		current += char;
	}

	if (escaped || quote) return undefined;
	if (current.trim()) {
		segments.push(current.trim());
	} else if (trailingSeparator && trailingSeparator !== ";" && trailingSeparator !== "\n") {
		return undefined;
	}

	return sawSeparator && segments.length > 1 ? segments : undefined;
}

function tokenizeSimpleCommand(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let tokenStarted = false;

	const pushToken = () => {
		if (!tokenStarted) return;
		tokens.push(current);
		current = "";
		tokenStarted = false;
	};

	for (let i = 0; i < segment.length; i++) {
		const char = segment[i];

		if (escaped) {
			if (char !== "\n") current += char;
			escaped = false;
			tokenStarted = true;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			tokenStarted = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(char)) {
			pushToken();
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (escaped || quote) return undefined;
	pushToken();
	return tokens.length > 0 ? tokens : undefined;
}

function normalizeCommandName(token: string): string | undefined {
	if (!token || token.startsWith("$")) return undefined;
	const lastSlash = token.lastIndexOf("/");
	if (lastSlash !== -1) {
		if (token.startsWith("./") || token.startsWith("../")) return undefined;
		token = token.slice(lastSlash + 1);
	}

	const normalized = token.toLowerCase().replace(/\.exe$/, "");
	return /^[a-z0-9][a-z0-9._+@-]*$/i.test(normalized) ? normalized : undefined;
}

function extractSimpleCommandName(segment: string): string | undefined {
	const tokens = tokenizeSimpleCommand(segment);
	if (!tokens) return undefined;

	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
		index++;
	}
	const command = tokens[index];
	if (!command || SHELL_KEYWORDS.has(command)) return undefined;
	return normalizeCommandName(command);
}

/**
 * Return unique, ordered command names when a command is a syntactically simple
 * multi-command chain suitable for a compact display summary. Returns undefined
 * when the command contains unsupported shell syntax or an invalid command name.
 */
export function summarizeBashCommand(command: string): string[] | undefined {
	const segments = splitTopLevelCommands(command);
	if (!segments) return undefined;

	const names: string[] = [];
	for (const segment of segments) {
		const name = extractSimpleCommandName(segment);
		if (!name) return undefined;
		if (!names.includes(name)) names.push(name);
	}

	return names.length > 0 ? names : undefined;
}
