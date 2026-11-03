/**
 * Write a models.json change back into the file's own text.
 *
 * The store applies ops to a parsed copy; this turns the difference between
 * the file's document and that copy into jsonc-parser edits, so comments,
 * trailing commas, key order, and untouched formatting stay as written.
 */

import {
	applyEdits,
	createScanner,
	type FormattingOptions,
	findNodeAtLocation,
	format,
	type JSONPath,
	modify,
	type Node,
	parseTree,
	SyntaxKind,
} from "jsonc-parser";
import { stripJsonComments } from "../../utils/json.ts";
import { isPlainObject, jsonEquals } from "./json-fields.ts";

type Insertion = { path: JSONPath; value: unknown; insert?: boolean };
type Change = Insertion | { path: JSONPath; remove: true };

/** The smallest set of path edits turning `before` into `after`. */
function diff(before: unknown, after: unknown, path: JSONPath, out: Change[]): void {
	if (jsonEquals(before, after)) return;
	if (isPlainObject(before) && isPlainObject(after)) {
		for (const key of Object.keys(before))
			if (!Object.hasOwn(after, key)) out.push({ path: [...path, key], remove: true });
		for (const [key, value] of Object.entries(after)) {
			if (Object.hasOwn(before, key)) diff(before[key], value, [...path, key], out);
			else out.push({ path: [...path, key], value });
		}
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		if (before.length === after.length) {
			for (const [index, value] of after.entries()) diff(before[index], value, [...path, index], out);
			return;
		}
		// Models are added at the end and removed anywhere; anything else rewrites the array.
		if (after.length > before.length && before.every((value, index) => jsonEquals(value, after[index]))) {
			for (let index = before.length; index < after.length; index++) {
				out.push({ path: [...path, index], value: after[index], insert: true });
			}
			return;
		}
		const removed = removedIndexes(before, after);
		if (removed) {
			for (const index of removed.reverse()) out.push({ path: [...path, index], remove: true });
			return;
		}
	}
	out.push({ path, value: after });
}

/** Indexes dropped from `before` when `after` is `before` minus some entries, else undefined. */
function removedIndexes(before: unknown[], after: unknown[]): number[] | undefined {
	const removed: number[] = [];
	let next = 0;
	for (const [index, value] of before.entries()) {
		if (next < after.length && jsonEquals(value, after[next])) next++;
		else removed.push(index);
	}
	return next === after.length ? removed : undefined;
}

/** Indentation and line ending as the file already uses them; none for a one-line file. */
function detectFormatting(text: string): FormattingOptions | undefined {
	if (!text.trim().includes("\n")) return undefined;
	const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
	return {
		insertSpaces: !indent.startsWith("\t"),
		tabSize: indent.startsWith("\t") ? 1 : indent.length,
		eol: text.includes("\r\n") ? "\r\n" : "\n",
	};
}

/**
 * Remove a property or array element with its separating comma, and its line
 * when nothing else is on it. jsonc-parser's own removal keeps a trailing comma
 * after the last entry, which leaves `{ , }` behind.
 */
function removeNode(text: string, root: Node, path: JSONPath): string {
	const value = findNodeAtLocation(root, path);
	if (!value) return text;
	const node = value.parent?.type === "property" ? value.parent : value;
	const siblings = node.parent?.children ?? [];
	const index = siblings.indexOf(node);
	let start = node.offset;
	let end = node.offset + node.length;
	const after = nextToken(text, end);
	if (after.kind === SyntaxKind.CommaToken) end = after.end;
	else if (index > 0) {
		const previous = siblings[index - 1]!;
		const comma = nextToken(text, previous.offset + previous.length);
		if (comma.kind === SyntaxKind.CommaToken) start = comma.start;
	}
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = text.indexOf("\n", end);
	if (/^[ \t]*$/.test(text.slice(lineStart, start)) && lineEnd >= 0 && /^[ \t\r]*$/.test(text.slice(end, lineEnd))) {
		return text.slice(0, lineStart) + text.slice(lineEnd + 1);
	}
	return text.slice(0, start) + text.slice(end);
}

function nextToken(text: string, offset: number): { kind: SyntaxKind; start: number; end: number } {
	const scanner = createScanner(text, true);
	scanner.setPosition(offset);
	const kind = scanner.scan();
	const start = scanner.getTokenOffset();
	return { kind, start, end: start + scanner.getTokenLength() };
}

/**
 * Append to a multi-line object or array on a line of its own, after the last
 * member's trailing comma and same-line comment. jsonc-parser inserts before
 * that comma and reformats the whole line, which would expand a one-line
 * neighbor and hand its comment to the new member. Undefined when the change
 * is not such an append.
 */
function appendMember(text: string, change: Insertion, formatting: FormattingOptions): string | undefined {
	const root = parseTree(text);
	const container = root && findNodeAtLocation(root, change.path.slice(0, -1));
	if (!container?.children?.length) return undefined;
	if (!text.slice(container.offset, container.offset + container.length).includes("\n")) return undefined;
	const [raw] = modify(text, change.path, change.value, { isArrayInsertion: change.insert });
	if (!raw || raw.length !== 0 || !raw.content.startsWith(",")) return undefined;
	const scanner = createScanner(text, false);
	scanner.setPosition(raw.offset);
	const scan = (): SyntaxKind => {
		let kind: SyntaxKind;
		do kind = scanner.scan();
		while (kind === SyntaxKind.Trivia);
		return kind;
	};
	let kind = scan();
	const trailingComma = kind === SyntaxKind.CommaToken;
	let anchor = raw.offset;
	if (trailingComma) {
		anchor = scanner.getPosition();
		kind = scan();
	}
	if (kind === SyntaxKind.LineCommentTrivia) anchor = scanner.getPosition();
	const member = `${formatting.eol ?? "\n"}${raw.content.slice(1)}${trailingComma ? "," : ""}`;
	const edits = [{ offset: anchor, length: 0, content: member }];
	if (!trailingComma) edits.unshift({ offset: raw.offset, length: 0, content: "," });
	const edited = applyEdits(text, edits);
	const start = anchor + (trailingComma ? 0 : 1);
	return applyEdits(
		edited,
		format(edited, { offset: start, length: member.length }, { ...formatting, keepLines: false }),
	);
}

/**
 * `rawText` edited so it parses to `after`. Falls back to fresh two-space JSON
 * if the edited text would not read back as `after`.
 */
export function editJsonText(rawText: string, before: unknown, after: unknown): string {
	const fallback = `${JSON.stringify(after, null, 2)}\n`;
	const changes: Change[] = [];
	diff(before, after, [], changes);
	if (changes.some((change) => change.path.length === 0)) return fallback;
	const bom = rawText.startsWith("\uFEFF") ? "\uFEFF" : "";
	const formattingOptions = detectFormatting(rawText);
	let text = rawText.slice(bom.length);
	for (const change of changes) {
		if ("remove" in change) {
			const root = parseTree(text);
			if (root) text = removeNode(text, root, change.path);
			continue;
		}
		const appended = formattingOptions ? appendMember(text, change, formattingOptions) : undefined;
		text =
			appended ??
			applyEdits(
				text,
				modify(text, change.path, change.value, { formattingOptions, isArrayInsertion: change.insert }),
			);
	}
	try {
		if (jsonEquals(JSON.parse(stripJsonComments(text)), after)) return bom + text;
	} catch {
		// Fall through to the rewrite below.
	}
	return fallback;
}
