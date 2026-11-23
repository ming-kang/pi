import { readFileSync } from "node:fs";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import type { Skill } from "./skills.ts";

const CJK_PUNCTUATION_SOURCE =
	"(?:(?=\\p{Punctuation})[\\p{Script_Extensions=Han}\\p{Script_Extensions=Hiragana}\\p{Script_Extensions=Katakana}\\p{Script_Extensions=Hangul}\\p{Script_Extensions=Bopomofo}]|[，．。：；！？（）［］｛｝“”‘’…—])";
const SEPARATOR_SOURCE = `(?:\\s|${CJK_PUNCTUATION_SOURCE})`;
// A `/skill` token starts the text or follows a separator, optionally behind opening brackets or quotes.
// Backticks are not openers: `/skill:name` written as inline code stays literal.
const BOUNDARY_PREFIX_SOURCE = `(?:^|${SEPARATOR_SOURCE})[([{"']*`;
const QUERY_CHAR_SOURCE = `(?:(?!${SEPARATOR_SOURCE}|[\\/)}>"'\`]).)`;

const SKILL_AUTOCOMPLETE_TOKEN_REGEX = new RegExp(
	`${BOUNDARY_PREFIX_SOURCE}(\\/skill(?::(${QUERY_CHAR_SOURCE}*)|[ \\t]+(${QUERY_CHAR_SOURCE}*))?)$`,
	"u",
);
const SKILL_REFERENCE_START_REGEX = new RegExp(`${BOUNDARY_PREFIX_SOURCE}\\/skill:`, "gu");
const SKILL_REFERENCE_MARKER = "/skill:";
const NAME_CHAR_REGEX = /[\p{L}\p{N}\p{M}_\-/]/u;

const FENCE_OPEN_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;
const PARAGRAPH_BREAK_REGEX = /\r?\n[ \t]*\r?\n/g;
const BACKTICK_RUN_REGEX = /`+/g;

export interface SkillAutocompleteToken {
	prefix: string;
	query: string;
	hasSpace: boolean;
}

interface TextRange {
	start: number;
	end: number;
}

interface SkillReference extends TextRange {
	skill: Skill;
}

/**
 * Returns the `/skill`, `/skill:query`, or `/skill query` token that ends at the cursor.
 * Tokens inside Markdown code (inline spans or fenced blocks) are ignored.
 */
export function extractSkillAutocompleteToken(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): SkillAutocompleteToken | null {
	const lineBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
	if (!lineBeforeCursor.includes("/skill")) return null;
	const match = SKILL_AUTOCOMPLETE_TOKEN_REGEX.exec(lineBeforeCursor);
	if (!match) return null;
	const prefix = match[1]!;
	const textBeforeCursor = [...lines.slice(0, cursorLine), lineBeforeCursor].join("\n");
	if (isInCode(findCodeRanges(textBeforeCursor, true), textBeforeCursor.length - prefix.length)) return null;
	const spaceQuery = match[3];
	return {
		prefix,
		query: match[2] ?? spaceQuery ?? "",
		hasSpace: spaceQuery !== undefined,
	};
}

/**
 * Expands `/skill:name` references to skill blocks placed above the user text.
 * References that only lead the message are stripped from it; references inside prose keep the text intact.
 */
export function expandSkillReferences(
	text: string,
	skills: readonly Skill[],
	onError?: (filePath: string, error: unknown) => void,
): string {
	if (!text.includes(SKILL_REFERENCE_MARKER) || skills.length === 0) return text;

	const matches = findSkillReferences(text, skills);
	if (matches.length === 0) return text;

	const seenSkills = new Set<string>();
	const skillBlocks: string[] = [];
	let hadReadError = false;

	for (const { skill } of matches) {
		if (seenSkills.has(skill.name)) continue;
		seenSkills.add(skill.name);
		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			skillBlocks.push(
				`<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
			);
		} catch (error) {
			hadReadError = true;
			onError?.(skill.filePath, error);
		}
	}

	if (skillBlocks.length === 0) return text;

	const afterLastMatch = text.slice(matches[matches.length - 1]!.end);
	const isContiguousLeadingPrefix =
		!hadReadError &&
		(afterLastMatch === "" || /^\s/.test(afterLastMatch)) &&
		matches.every((entry, index) => {
			const prevEnd = index === 0 ? 0 : matches[index - 1]!.end;
			return text.slice(prevEnd, entry.start).trim() === "";
		});

	const userMessage = isContiguousLeadingPrefix ? afterLastMatch.trim() : text.trim();

	return userMessage ? `${skillBlocks.join("\n\n")}\n\n${userMessage}` : skillBlocks.join("\n\n");
}

/** Finds `/skill:name` references outside Markdown code, taking the longest loaded skill name at each one. */
function findSkillReferences(text: string, skills: readonly Skill[]): SkillReference[] {
	// Longest names first, so `/skill:pdf-tools` prefers `pdf-tools` over `pdf`.
	const candidates = skills.filter((skill) => skill.name.length > 0).sort((a, b) => b.name.length - a.name.length);
	const references: SkillReference[] = [];
	let codeRanges: TextRange[] | undefined;

	for (const match of text.matchAll(SKILL_REFERENCE_START_REGEX)) {
		const nameStart = match.index + match[0].length;
		const skill = candidates.find(
			(candidate) =>
				text.startsWith(candidate.name, nameStart) && !continuesName(text, nameStart + candidate.name.length),
		);
		if (!skill) continue;
		const start = nameStart - SKILL_REFERENCE_MARKER.length;
		codeRanges ??= findCodeRanges(text, false);
		if (isInCode(codeRanges, start)) continue;
		references.push({ start, end: nameStart + skill.name.length, skill });
	}
	return references;
}

/**
 * Whether a skill name would continue at `index`: `/skill:pdf` does not match `/skill:pdfx`,
 * `/skill:pdf/x`, or `/skill:pdf.md`, but may end a sentence as `/skill:pdf.`.
 */
function continuesName(text: string, index: number): boolean {
	const char = codePointAt(text, index);
	if (char === ".") return NAME_CHAR_REGEX.test(codePointAt(text, index + 1));
	return NAME_CHAR_REGEX.test(char);
}

function codePointAt(text: string, index: number): string {
	const codePoint = text.codePointAt(index);
	return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function isInCode(codeRanges: readonly TextRange[], index: number): boolean {
	return codeRanges.some((range) => range.start <= index && index < range.end);
}

/**
 * Finds Markdown code: fenced blocks (``` or ~~~) and inline code spans. An unclosed fence runs to the end.
 * With `openSpanAtEnd`, an unclosed inline span on the last line also counts as code, because the text
 * after its backticks is still being typed.
 */
function findCodeRanges(text: string, openSpanAtEnd: boolean): TextRange[] {
	const ranges: TextRange[] = [];
	let fence: { marker: string; start: number } | undefined;
	let proseStart = 0;
	let lineStart = 0;

	for (const line of text.split("\n")) {
		const lineEnd = lineStart + line.length;
		if (fence) {
			const marker = FENCE_CLOSE_REGEX.exec(line)?.[1];
			if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
				ranges.push({ start: fence.start, end: lineEnd });
				fence = undefined;
				proseStart = lineEnd + 1;
			}
		} else {
			const open = FENCE_OPEN_REGEX.exec(line);
			// A backtick fence's info string cannot contain backticks: ```a``` is an inline span.
			if (open && !(open[1]!.startsWith("`") && open[2]!.includes("`"))) {
				addInlineCodeRanges(text, proseStart, lineStart, false, ranges);
				fence = { marker: open[1]!, start: lineStart };
			}
		}
		lineStart = lineEnd + 1;
	}

	if (fence) {
		ranges.push({ start: fence.start, end: text.length });
	} else {
		addInlineCodeRanges(text, proseStart, text.length, openSpanAtEnd, ranges);
	}
	return ranges;
}

/** Adds inline code spans in `text[start, end)`: a backtick run closed by the next equal run in the same paragraph. */
function addInlineCodeRanges(
	text: string,
	start: number,
	end: number,
	openSpanAtEnd: boolean,
	ranges: TextRange[],
): void {
	const prose = text.slice(start, end);
	const paragraphBounds = [0];
	for (const paragraphBreak of prose.matchAll(PARAGRAPH_BREAK_REGEX)) {
		paragraphBounds.push(paragraphBreak.index, paragraphBreak.index + paragraphBreak[0].length);
	}
	paragraphBounds.push(prose.length);

	for (let i = 0; i < paragraphBounds.length; i += 2) {
		const paragraphStart = start + paragraphBounds[i]!;
		const paragraphEnd = start + paragraphBounds[i + 1]!;
		const isLast = i + 2 >= paragraphBounds.length;
		const runs = [...text.slice(paragraphStart, paragraphEnd).matchAll(BACKTICK_RUN_REGEX)].map((run) => ({
			start: paragraphStart + run.index,
			length: run[0].length,
		}));
		for (let open = 0; open < runs.length; open++) {
			const opening = runs[open]!;
			const close = runs.findIndex((run, index) => index > open && run.length === opening.length);
			if (close !== -1) {
				ranges.push({ start: opening.start, end: runs[close]!.start + opening.length });
				open = close;
			} else if (openSpanAtEnd && isLast && !text.slice(opening.start, paragraphEnd).includes("\n")) {
				ranges.push({ start: opening.start, end: paragraphEnd });
				break;
			}
		}
	}
}
