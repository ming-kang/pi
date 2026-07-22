/**
 * contents.ts — page-boundary truncation for deepwiki `contents` responses.
 *
 * Zero-import pure module so `node scratch/<x>.ts` can drive it directly (this
 * repo has no node_modules; bare-package imports would fail to resolve there).
 * client.ts imports PAGE_HEADER_RE from here, so page-title extraction and
 * truncation chunking share one definition and cannot drift apart.
 *
 * Model-facing output must stay bounded: a full generated wiki can reach
 * hundreds of KB. Past CONTENTS_CHAR_BUDGET the text is cut at "# Page:"
 * boundaries — whole pages are kept in order, at least the beginning of the
 * first page always survives — and a trailing notice states what was omitted
 * and how to get it (read a single page via the `page` parameter, or ask a
 * focused question). extractPage implements that single-page read: upstream
 * has no per-page fetch, so a page is sliced locally out of the full text.
 *
 * Determinism matters: callDeepWiki caches the FULL response and the caller
 * re-truncates on every call, so cached and fresh calls must produce
 * byte-identical text. Pure function + constant budget guarantees that.
 */

/** Page-header line of a DeepWiki contents response ("# Page: <title>"). */
export const PAGE_HEADER_RE = /^#\s+Page:\s+(.+)$/;

export const CONTENTS_CHAR_BUDGET = 120_000;

/** Cap for omitted page titles inside the notice — the notice itself is bounded. */
const OMITTED_TITLES_MAX = 20;

export interface ContentsTruncation {
	/** Truncated body plus trailing notice; equals the input when not truncated. */
	text: string;
	truncated: boolean;
	/** Page chunks found in the full text (0 = no "# Page:" markers). */
	totalPages: number;
	/** Pages fully or partially shown (a mid-page cut still counts its page). */
	shownPages: number;
	/** Body characters dropped by the cut (the notice is not counted). */
	truncatedChars: number;
}

interface PageChunk {
	title: string;
	start: number;
}

/** Locate every page-header line as a character offset into the full text. */
function pageOffsets(text: string): PageChunk[] {
	const re = new RegExp(PAGE_HEADER_RE.source, "gm");
	const chunks: PageChunk[] = [];
	let match = re.exec(text);
	while (match !== null) {
		chunks.push({ title: match[1]!.trim(), start: match.index });
		match = re.exec(text);
	}
	return chunks;
}

/**
 * Hard-cut `text` to at most `budget` chars, preferring the last newline within
 * the budget so the cut lands between lines. A newline too close to the start
 * (< 40% of the budget) is ignored — a hard cut keeps more content than a tiny
 * stub, using the same word-boundary heuristic as other bounded text output.
 */
function cutAtLineBoundary(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const slice = text.slice(0, budget);
	const lastNewline = slice.lastIndexOf("\n");
	return lastNewline >= Math.floor(budget * 0.4) ? slice.slice(0, lastNewline) : slice;
}

function buildNotice(opts: {
	shownPages: number;
	totalPages: number;
	keptChars: number;
	fullChars: number;
	omittedTitles: string[];
	partialLastPage: boolean;
}): string {
	const pagesPart =
		opts.totalPages > 0 ? `showing ${opts.shownPages} of ${opts.totalPages} pages` : "showing the beginning";
	const lines = [`[DeepWiki contents truncated — ${pagesPart} (${opts.keptChars} of ${opts.fullChars} chars).`];
	if (opts.partialLastPage) lines.push("The last shown page is itself truncated.");
	if (opts.omittedTitles.length > 0) {
		const shown = opts.omittedTitles.slice(0, OMITTED_TITLES_MAX).join("; ");
		const more = opts.omittedTitles.length - OMITTED_TITLES_MAX;
		lines.push(`Omitted pages: ${shown}${more > 0 ? ` … +${more} more` : ""}.`);
		lines.push(
			`Read an omitted page with {action: "contents", page: "<title>"}, or use action "question" for a targeted answer.]`,
		);
	} else {
		lines.push(`For the missing remainder, use action "question" with a focused question.]`);
	}
	return lines.join("\n");
}

/**
 * Truncate a contents response to `budget` chars at page boundaries and append
 * an omission notice. Below budget the input is returned untouched.
 */
export function truncateContentsByPages(text: string, budget = CONTENTS_CHAR_BUDGET): ContentsTruncation {
	const chunks = pageOffsets(text);
	const totalPages = chunks.length;

	if (text.length <= budget) {
		return { text, truncated: false, totalPages, shownPages: totalPages, truncatedChars: 0 };
	}

	let kept: string;
	let shownPages: number;
	let partialLastPage = false;

	if (totalPages === 0) {
		// No page markers: treat the whole text as one block and cut at a line.
		kept = cutAtLineBoundary(text, budget);
		shownPages = 0;
	} else {
		// Accumulate the preamble (anything before the first marker) plus whole
		// pages, in order, while they fit.
		const preambleEnd = chunks[0]!.start;
		shownPages = 0;
		let end = preambleEnd;
		for (let i = 0; i < chunks.length; i++) {
			const pageEnd = i + 1 < chunks.length ? chunks[i + 1]!.start : text.length;
			if (pageEnd > budget) break;
			end = pageEnd;
			shownPages++;
		}
		if (shownPages === 0) {
			// Even the first page does not fit: cut inside it so at least the
			// document head and the first page's opening survive.
			kept = cutAtLineBoundary(text, budget);
			shownPages = 1;
			partialLastPage = true;
		} else {
			kept = text.slice(0, end);
		}
	}

	const omittedTitles = chunks.slice(shownPages).map((chunk) => chunk.title);
	const notice = buildNotice({
		shownPages,
		totalPages,
		keptChars: kept.length,
		fullChars: text.length,
		omittedTitles,
		partialLastPage,
	});

	return {
		text: `${kept}\n\n${notice}`,
		truncated: true,
		totalPages,
		shownPages,
		truncatedChars: text.length - kept.length,
	};
}

export interface PageSlice {
	/** Resolved page title as it appears in the header line. */
	title: string;
	/** Page text from its header line up to the next page header (or EOF). */
	text: string;
	/** 1-based position among the page chunks. */
	index: number;
}

export interface PageLookup {
	found?: PageSlice;
	/** All page titles in document order — for self-healing not-found errors. */
	titles: string[];
}

/** Strip outline numbers copied from structure TOC (e.g. `4.4 Extension System` → `Extension System`). */
export function normalizePageRef(pageRef: string | number): string | number {
	if (typeof pageRef === "number") return pageRef;
	const trimmed = pageRef.trim();
	if (!trimmed) return trimmed;
	const stripped = trimmed.replace(/^\d+(?:\.\d+)*\s+/, "");
	return stripped.length > 0 ? stripped : trimmed;
}

/**
 * Slice one wiki page out of a full contents response. `pageRef` is matched
 * leniently, in this order: case-insensitive exact title, unique partial
 * title, or a 1-based index for purely numeric refs (matching the order shown
 * by structure and truncation notices). No match (or a wiki without page
 * markers) returns just the title list so the caller can report what exists.
 */
export function extractPage(text: string, pageRef: string | number): PageLookup {
	const chunks = pageOffsets(text);
	const titles = chunks.map((chunk) => chunk.title);
	if (chunks.length === 0) return { titles };

	const normalized = normalizePageRef(pageRef);
	const ref = String(normalized).trim();
	let idx = -1;
	if (typeof normalized === "number" || /^\d+$/.test(ref)) {
		const ordinal = typeof normalized === "number" ? normalized : Number.parseInt(ref, 10);
		if (ordinal >= 1 && ordinal <= chunks.length) idx = ordinal - 1;
	} else if (ref) {
		const lower = ref.toLowerCase();
		idx = titles.findIndex((title) => title.toLowerCase() === lower);
		if (idx === -1) {
			const partial = titles.reduce<number[]>((acc, title, i) => {
				if (title.toLowerCase().includes(lower)) acc.push(i);
				return acc;
			}, []);
			if (partial.length === 1) idx = partial[0]!;
		}
	}
	if (idx === -1) return { titles };

	const start = chunks[idx]!.start;
	const end = idx + 1 < chunks.length ? chunks[idx + 1]!.start : text.length;
	return { found: { title: titles[idx]!, text: text.slice(start, end), index: idx + 1 }, titles };
}
