import { stripComments } from "jsonc-parser";

/**
 * Blank out line (`//`) and block comments and trailing commas in JSON,
 * leaving string literals untouched. Each removed character becomes a space,
 * so a comment between two tokens still separates them instead of joining
 * `1` and `2` into `12`, and parse errors keep the file's line and column.
 * Comments are found by jsonc-parser's scanner so comment-like sequences
 * inside strings survive; the trailing-comma pass keeps the same protection.
 */
export function stripJsonComments(input: string): string {
	return stripComments(input, " ").replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) =>
		tail === undefined ? m : ` ${tail}`,
	);
}
