import { stripComments } from "jsonc-parser";

/**
 * Strip line (`//`) and block comments and trailing commas from JSON, leaving
 * string literals untouched. Comments are removed by jsonc-parser's scanner so
 * comment-like sequences inside strings survive; the trailing-comma pass keeps
 * the same protection. Genuinely malformed JSON still fails to parse.
 */
export function stripJsonComments(input: string): string {
	return stripComments(input, "").replace(
		/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
		(m, tail) => tail ?? (m[0] === '"' ? m : ""),
	);
}
