import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { DEFAULT_EXCLUDES } from "./excludes.ts";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;

const FIELD_WEIGHTS = { dir_name: 1.0, path_tokens: 4.0, metadata: 3.0, headers: 2.0 } as const;
type FieldName = keyof typeof FIELD_WEIGHTS;

/** Membership form of the canonical list, for the hot path in the profile walk. */
const EXCLUDE_SET = new Set(DEFAULT_EXCLUDES);

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"need",
	"dare",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"and",
	"but",
	"or",
	"nor",
	"so",
	"yet",
	"both",
	"either",
	"neither",
	"not",
	"only",
	"own",
	"same",
	"than",
	"too",
	"very",
	"just",
	"also",
	"this",
	"that",
	"these",
	"those",
	"here",
	"there",
	"all",
	"any",
	"some",
	"no",
	"none",
	"each",
	"every",
	"other",
	"another",
	"such",
	"get",
	"set",
	"use",
	"used",
	"using",
	"make",
	"made",
	"if",
	"then",
	"else",
	"return",
	"new",
	"like",
	"well",
	"where",
	"which",
	"who",
	"what",
	"when",
	"why",
	"how",
	"it",
	"its",
	"we",
	"you",
	"your",
]);

const SOURCE_PATH_PATTERNS = ["/src/", "/core/", "/lib/", "/internal/", "/pkg/", "/cmd/"];
const NOISE_PATH_PATTERNS = [
	"/migrations/",
	"/test/",
	"/__tests__/",
	"/fixtures/",
	"/examples/",
	"/vendor/",
	"/mock/",
	"/mocks/",
	"/i18n/",
	"/locales/",
	"/versions/",
];

const STEM_PATTERNS: Array<[RegExp, string]> = [
	[/^(.+)(ies)$/, "$1y"],
	[/^(.+)([^aeiou])(es)$/, "$1$2"],
	[/^(.+)([^aeiou])(s)$/, "$1$2"],
	[/^(.+)(ing)$/, "$1"],
	[/^(.+)(edly)$/, "$1"],
	[/^(.+)(ly)$/, "$1"],
	[/^(.+)(ed)$/, "$1"],
	[/^(.+)(ation)$/, "$1ate"],
	[/^(.+)(tion)$/, "$1t"],
	[/^(.+)(ment)$/, "$1"],
	[/^(.+)(ness)$/, "$1"],
	[/^(.+)(ful)$/, "$1"],
	[/^(.+)(less)$/, "$1"],
	[/^(.+)(able)$/, "$1"],
	[/^(.+)(ible)$/, "$1"],
	[/^(.+)(ally)$/, "$1al"],
	[/^(.+)(ity)$/, "$1"],
	[/^(.+)(ive)$/, "$1"],
];

type CharType = "upper" | "lower" | "digit" | "sep";
function charType(c: string): CharType {
	if (c >= "A" && c <= "Z") return "upper";
	if (c >= "a" && c <= "z") return "lower";
	if (c >= "0" && c <= "9") return "digit";
	return "sep";
}

export function splitByCase(input: string): string[] {
	if (!input) return [];
	const chars = [...input];
	const tokens: string[] = [];
	let current = "";
	let prev: CharType | "" = "";
	const flush = () => {
		if (current) tokens.push(current);
		current = "";
	};
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i]!;
		const t = charType(c);
		if (t === "sep") {
			flush();
			prev = "sep";
			continue;
		}
		let boundary = false;
		if (current) {
			if (prev === "lower" && t === "upper")
				boundary = true; // fooBar
			else if (prev === "digit" && t !== "digit")
				boundary = true; // 2bar
			else if (prev !== "digit" && t === "digit")
				boundary = true; // foo2
			else if (prev === "upper" && t === "upper") {
				const next = chars[i + 1];
				if (next && charType(next) === "lower") boundary = true; // FOO|Bar
			}
		}
		if (boundary) flush();
		current += c;
		prev = t;
	}
	flush();
	return tokens;
}

export function stem(word: string): string {
	if (!word || word.length < 3) return word;
	const w = word.toLowerCase();
	for (const [pattern, replacement] of STEM_PATTERNS) {
		if (pattern.test(w)) return w.replace(pattern, replacement);
	}
	return w;
}

export function tokenize(text: string, minLen = 2): string[] {
	if (!text) return [];
	const tokens: string[] = [];
	for (const seg of text.split(/[\s\-./\\]+/)) {
		if (!seg || seg.length < minLen) continue;
		for (const word of splitByCase(seg)) {
			const lower = word.toLowerCase();
			if (lower.length >= minLen && !STOPWORDS.has(lower)) tokens.push(stem(lower));
		}
	}
	return tokens;
}

export function tokenizePath(pathStr: string): string[] {
	if (!pathStr) return [];
	const tokens: string[] = [];
	for (const seg of pathStr.replace(/[/\\]/g, " ").split(/\s+/)) {
		if (!seg || seg.length < 2) continue;
		for (const word of splitByCase(seg)) {
			const lower = word.toLowerCase();
			if (lower.length >= 2) tokens.push(stem(lower));
		}
	}
	return tokens;
}

interface DirProfile {
	dir_name: string;
	path_tokens: string[];
	path_tokens_text: string;
	metadata: string;
	headers: string[];
	headers_text: string;
	file_count: number;
	file_paths: string[];
	_tok?: Record<FieldName, string[]>;
}

const HEADER_EXTS = new Set([".md", ".mdx", ".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

function extractMetadata(dirPath: string): string {
	const metadata: string[] = [];
	const pkgPath = join(dirPath, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
				name?: string;
				description?: string;
				keywords?: string[];
				dependencies?: Record<string, string>;
			};
			if (pkg.name) metadata.push(pkg.name);
			if (pkg.description) metadata.push(...tokenize(pkg.description));
			if (Array.isArray(pkg.keywords)) metadata.push(...pkg.keywords.flatMap((k) => tokenize(k)));
			if (pkg.dependencies) metadata.push(...Object.keys(pkg.dependencies).flatMap((k) => tokenize(k)));
		} catch {}
	}
	for (const [file, re] of [
		["go.mod", /module\s+(\S+)/],
		["Cargo.toml", /name\s*=\s*"([^"]+)"/],
		["pyproject.toml", /name\s*=\s*"([^"]+)"/],
	] as const) {
		const p = join(dirPath, file);
		if (!existsSync(p)) continue;
		try {
			const m = readFileSync(p, "utf-8").match(re);
			if (m?.[1]) metadata.push(...tokenizePath(m[1]));
		} catch {}
	}
	return metadata.join(" ");
}

function extractFileHeaders(filePath: string): string {
	try {
		const content = readFileSync(filePath, "utf-8").slice(0, 2000);
		const headers: string[] = [];
		for (const h of content.match(/^#+\s+.+$/gm) ?? []) headers.push(h.replace(/^#+\s+/, ""));
		for (const line of content.split("\n").slice(0, 10)) {
			const c = line.match(/^\s*(?:(?:\/\/|#|;|\*)\s*)(.+)$/);
			if (c) headers.push(c[1]!);
		}
		return headers.join(" ");
	} catch {
		return "";
	}
}

const _profileCache = new Map<string, { profile: DirProfile; cachedAt: number }>();
const PROFILE_CACHE_TTL_MS = 120_000;
const MAX_HEADER_FILES = 80;

function buildDirectoryProfile(projectRoot: string, dirName: string, excludePaths: string[], maxDepth = 3): DirProfile {
	const cacheKey = `${projectRoot}|${dirName}|${[...excludePaths].sort().join(",")}`;
	const cached = _profileCache.get(cacheKey);
	if (cached && Date.now() - cached.cachedAt < PROFILE_CACHE_TTL_MS) return cached.profile;

	const dirPath = join(projectRoot, dirName);
	const profile: DirProfile = {
		dir_name: dirName,
		path_tokens: [],
		path_tokens_text: "",
		metadata: "",
		headers: [],
		headers_text: "",
		file_count: 0,
		file_paths: [],
	};
	const excludeSet = new Set(excludePaths);
	let headerBudget = MAX_HEADER_FILES;

	const walk = (currentPath: string, depth: number): void => {
		if (depth > maxDepth) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(currentPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (EXCLUDE_SET.has(name) || excludeSet.has(name)) continue;
			if (name.startsWith(".") && name !== ".github") continue;
			const fullPath = join(currentPath, name);
			const relPath = relative(projectRoot, fullPath);
			if (entry.isDirectory()) {
				profile.path_tokens.push(relPath);
				walk(fullPath, depth + 1);
			} else if (entry.isFile()) {
				profile.path_tokens.push(relPath);
				profile.file_paths.push(relPath);
				profile.file_count++;
				if (headerBudget > 0 && HEADER_EXTS.has(extname(name))) {
					const headers = extractFileHeaders(fullPath);
					if (headers) profile.headers.push(headers);
					headerBudget--;
				}
			}
		}
	};
	walk(dirPath, 1);

	profile.metadata = extractMetadata(dirPath);
	profile.path_tokens_text = profile.path_tokens.join(" ");
	profile.headers_text = profile.headers.join(" ");
	_profileCache.set(cacheKey, { profile, cachedAt: Date.now() });
	return profile;
}

function computeIDF(documents: string[][]): Record<string, number> {
	const docCount = documents.length;
	const termDocCount: Record<string, number> = {};
	for (const doc of documents) {
		for (const term of new Set(doc)) termDocCount[term] = (termDocCount[term] ?? 0) + 1;
	}
	const idf: Record<string, number> = {};
	for (const [term, count] of Object.entries(termDocCount)) {
		idf[term] = Math.log((docCount - count + 0.5) / (count + 0.5) + 1);
	}
	return idf;
}

function bm25FieldScore(
	queryTerms: string[],
	fieldTerms: string[],
	avgLen: number,
	fieldLen: number,
	idf: Record<string, number>,
): number {
	const termFreqs: Record<string, number> = {};
	for (const t of fieldTerms) termFreqs[t] = (termFreqs[t] ?? 0) + 1;
	let score = 0;
	for (const term of queryTerms) {
		const tf = termFreqs[term] ?? 0;
		if (tf === 0) continue;
		const termIDF = idf[term] ?? Math.log(2);
		const numerator = tf * (BM25_K1 + 1);
		const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (fieldLen / avgLen));
		score += termIDF * (numerator / denominator);
	}
	return score;
}

function bm25fScore(
	queryTerms: string[],
	profile: DirProfile,
	avgFieldLens: Record<FieldName, number>,
	idf: Record<string, number>,
): number {
	const tok = profile._tok!;
	let total = 0;
	for (const name of Object.keys(FIELD_WEIGHTS) as FieldName[]) {
		const terms = tok[name];
		const avgLen = avgFieldLens[name] || 50;
		const fieldLen = terms.length || 1;
		total += FIELD_WEIGHTS[name] * bm25FieldScore(queryTerms, terms, avgLen, fieldLen, idf);
	}
	return total;
}

export type ProbeFn = (pattern: string, signal?: AbortSignal) => Promise<string[]>;

function regexEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectProbeTerms(queryTerms: string[], idf: Record<string, number>, maxTerms = 6): string[] {
	const sorted = [...new Set(queryTerms)].map((t) => ({ t, idf: idf[t] ?? 0 })).sort((a, b) => b.idf - a.idf);
	return sorted.slice(0, maxTerms).map((x) => x.t);
}

async function probeHits(
	probeFn: ProbeFn,
	projectRoot: string,
	topDirs: string[],
	probeTerms: string[],
	signal?: AbortSignal,
): Promise<Record<string, number>> {
	const dirHits: Record<string, number> = {};
	for (const d of topDirs) dirHits[d] = 0;
	if (probeTerms.length === 0) return dirHits;
	let files: string[];
	try {
		files = await probeFn(probeTerms.map(regexEscape).join("|"), signal);
	} catch {
		return dirHits;
	}
	for (const f of files) {
		const rel = isAbsolute(f) ? relative(projectRoot, f) : relative(projectRoot, resolve(projectRoot, f));
		if (rel.startsWith("..") || isAbsolute(rel)) continue;
		const top = rel.split(/[/\\]/)[0];
		if (top && Object.hasOwn(dirHits, top)) dirHits[top]++;
	}
	return dirHits;
}

function computeProbeScore(hits: number, fileCount: number): number {
	if (hits === 0) return 0;
	return Math.log(1 + hits) / Math.sqrt(1 + fileCount);
}

interface Ranked {
	dir: string;
	score: number;
}

function rrfFusion(rankings: Ranked[][]): Ranked[] {
	const finalScores: Record<string, number> = {};
	for (const ranking of rankings) {
		ranking.forEach((entry, pos) => {
			finalScores[entry.dir] = (finalScores[entry.dir] ?? 0) + 1 / (RRF_K + pos + 1);
		});
	}
	return Object.entries(finalScores)
		.map(([dir, score]) => ({ dir, score }))
		.sort((a, b) => b.score - a.score);
}

const K_MIN = 3;
const K_MAX = 10;
const ENTROPY_GAMMA = 0.5;
const SOFTMAX_TEMP = 1.0;
const TAIL_SCAN_WINDOW = 6;

function adaptiveTopK(fused: Ranked[], userTopK: number, N: number): string[] {
	if (fused.length <= K_MIN) return fused.map((r) => r.dir);
	const scores = fused.map((r) => r.score);

	const kBase = Math.max(userTopK, Math.min(K_MAX, Math.ceil(N * 0.15)));

	let maxGap = 0;
	let kKnee = kBase;
	const searchEnd = Math.min(K_MAX, scores.length - 1);
	for (let i = K_MIN - 1; i < searchEnd; i++) {
		const gap = scores[i]! - scores[i + 1]!;
		if (gap > maxGap) {
			maxGap = gap;
			kKnee = i + 1;
		}
	}

	const maxScore = scores[0]!;
	const expScores = scores.map((s) => Math.exp((s - maxScore) / SOFTMAX_TEMP));
	const expSum = expScores.reduce((a, b) => a + b, 0);
	const probs = expScores.map((e) => e / expSum);
	const entropy = -probs.reduce((h, p) => h + (p > 0 ? p * Math.log(p) : 0), 0);
	const hNorm = scores.length > 1 ? entropy / Math.log(scores.length) : 0;
	const kEntropy = Math.ceil(kBase * (1 + ENTROPY_GAMMA * hNorm));

	const primaryK = Math.max(K_MIN, Math.min(K_MAX, Math.max(kBase, kKnee, kEntropy)));
	const hotDirs = fused.slice(0, primaryK).map((r) => r.dir);

	if (fused.length > primaryK) {
		const cutoffScore = scores[primaryK - 1]!;
		const headDecayRate = primaryK > 1 ? (scores[0]! - cutoffScore) / (primaryK - 1) : 0;
		const tailThreshold = Math.max(cutoffScore - headDecayRate, cutoffScore * 0.4);
		for (let i = primaryK; i < fused.length && i < primaryK + TAIL_SCAN_WINDOW; i++) {
			if (scores[i]! >= tailThreshold) hotDirs.push(fused[i]!.dir);
			else break;
		}
	}
	return hotDirs;
}

function extractPathSpines(
	profiles: Record<string, DirProfile>,
	queryTerms: string[],
	keywords: string[],
	topN = 30,
): string[] {
	const allTerms = [...new Set([...queryTerms, ...keywords])];
	if (allTerms.length === 0) return [];
	const candidates: Array<{ path: string; score: number }> = [];
	for (const profile of Object.values(profiles)) {
		for (const filePath of profile.file_paths) {
			const pathTokens = tokenizePath(filePath);
			const pathText = filePath.toLowerCase();
			const parts = filePath.split(/[/\\]/);
			const fileName = parts[parts.length - 1]!.replace(/\.[^.]+$/, "").toLowerCase();
			const fileNameTokens = tokenizePath(fileName);

			let score = 0;
			for (const term of allTerms) {
				if (fileName.includes(term) || fileNameTokens.some((ft) => ft === term)) score += 4;
				else if (pathText.includes(term)) score += 2;
				else if (pathTokens.some((pt) => pt.includes(term) || term.includes(pt))) score += 1;
			}
			if (score > 0) {
				const lowerPath = `/${pathText}`;
				if (SOURCE_PATH_PATTERNS.some((p) => lowerPath.includes(p))) score *= 1.5;
				if (NOISE_PATH_PATTERNS.some((p) => lowerPath.includes(p))) score *= 0.3;
				candidates.push({ path: filePath, score });
			}
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates.slice(0, topN).map((c) => c.path);
}

function fileAggregateScore(queryTerms: string[], profile: DirProfile): number {
	const { file_paths } = profile;
	if (file_paths.length === 0) return 0;
	const alpha = 0.5;
	const threshold = 0.3;
	const fileScores: number[] = [];
	for (const relPath of file_paths.slice(0, 200)) {
		const pathTokens = tokenizePath(relPath);
		let score = 0;
		for (const qt of queryTerms) {
			if (pathTokens.some((pt) => pt === qt)) score += 2.0;
			else if (pathTokens.some((pt) => pt.includes(qt) || qt.includes(pt))) score += 1.0;
			else if (relPath.toLowerCase().includes(qt)) score += 0.5;
		}
		if (score > 0) fileScores.push(score);
	}
	if (fileScores.length === 0) return 0;
	fileScores.sort((a, b) => b - a);
	const maxScore = fileScores[0]!;
	const densitySum = fileScores.filter((s) => s > threshold).reduce((sum, s) => sum + (s - threshold), 0);
	return maxScore + alpha * Math.log(1 + densitySum);
}

export interface ScoreOptions {
	topK?: number;
	probeFn?: ProbeFn;
	keywords?: string[];
	minReturn?: number;
	signal?: AbortSignal;
}

export interface ScoreResult {
	hotDirs: string[];
	pathSpines: string[];
	signals: Record<string, unknown>;
}

export async function scoreDirectories(
	query: string,
	projectRoot: string,
	topDirs: string[],
	excludePaths: string[] = [],
	options: ScoreOptions = {},
): Promise<ScoreResult> {
	const { topK = 4, probeFn, keywords = [], minReturn = 2, signal } = options;
	const queryTerms = tokenize(query);

	const profiles: Record<string, DirProfile> = {};
	for (const dir of topDirs) {
		const profile = buildDirectoryProfile(projectRoot, dir, excludePaths);
		profile._tok = {
			dir_name: tokenize(profile.dir_name),
			path_tokens: tokenize(profile.path_tokens_text),
			metadata: tokenize(profile.metadata),
			headers: tokenize(profile.headers_text),
		};
		profiles[dir] = profile;
	}

	const idf = computeIDF(
		Object.values(profiles).map((p) => [
			...p._tok!.dir_name,
			...p._tok!.path_tokens,
			...p._tok!.metadata,
			...p._tok!.headers,
		]),
	);

	const avgFieldLens: Record<FieldName, number> = { dir_name: 0, path_tokens: 0, metadata: 0, headers: 0 };
	const profileList = Object.values(profiles);
	for (const profile of profileList) {
		for (const name of Object.keys(FIELD_WEIGHTS) as FieldName[]) avgFieldLens[name] += profile._tok![name].length;
	}
	for (const name of Object.keys(avgFieldLens) as FieldName[]) {
		avgFieldLens[name] = profileList.length > 0 ? avgFieldLens[name] / profileList.length : 10;
	}

	const rankings: Ranked[][] = [];
	const signals: Record<string, unknown> = {};

	const bm25fRanking = topDirs
		.map((dir) => ({ dir, score: bm25fScore(queryTerms, profiles[dir]!, avgFieldLens, idf) }))
		.sort((a, b) => b.score - a.score);
	rankings.push(bm25fRanking);
	signals.bm25f = bm25fRanking.map((r) => r.dir);

	if (probeFn && queryTerms.length > 0) {
		const keywordTerms = keywords.flatMap((k) => tokenize(k));
		const probeTerms = selectProbeTerms([...new Set([...queryTerms, ...keywordTerms])], idf);
		if (probeTerms.length > 0) {
			const dirHits = await probeHits(probeFn, projectRoot, topDirs, probeTerms, signal);
			const probeRanking = topDirs
				.map((dir) => ({ dir, score: computeProbeScore(dirHits[dir] ?? 0, profiles[dir]!.file_count || 1) }))
				.sort((a, b) => b.score - a.score);
			rankings.push(probeRanking);
			signals.probe = probeRanking.map((r) => `${r.dir}:${dirHits[r.dir] ?? 0}`);
		}
	}

	if (keywords.length > 0) {
		const keywordTerms = keywords.flatMap((k) => tokenize(k));
		const keywordRanking = topDirs
			.map((dir) => {
				const text = profiles[dir]!.path_tokens_text.toLowerCase();
				return { dir, score: keywordTerms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0) };
			})
			.sort((a, b) => b.score - a.score);
		rankings.push(keywordRanking);
		signals.keywords = keywordRanking.map((r) => r.dir);
	}

	const fileAggRanking = topDirs
		.map((dir) => ({ dir, score: fileAggregateScore(queryTerms, profiles[dir]!) }))
		.sort((a, b) => b.score - a.score);
	if (fileAggRanking.some((r) => r.score > 0)) {
		rankings.push(fileAggRanking);
		signals.fileAgg = fileAggRanking.slice(0, 6).map((r) => `${r.dir}:${r.score.toFixed(2)}`);
	}

	const fused = rrfFusion(rankings);
	while (fused.length < minReturn && fused.length < topDirs.length) {
		const missing = topDirs.find((d) => !fused.some((f) => f.dir === d));
		if (!missing) break;
		fused.push({ dir: missing, score: 0.001 });
	}

	const pathSpines = extractPathSpines(profiles, queryTerms, keywords, 30);
	const hotDirs = adaptiveTopK(fused, topK, topDirs.length);
	return { hotDirs, pathSpines, signals };
}
