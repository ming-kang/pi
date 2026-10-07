import { isAbsolute, resolve } from "node:path";
import { createPiGrepFn } from "./grep-backend.ts";
import { PathSandbox } from "./sandbox.ts";
import { formatSearchResult, search } from "./search.ts";

function clampEnv(name: string, def: number, min: number, max: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	if (!Number.isFinite(parsed)) return def;
	return Math.min(max, Math.max(min, parsed));
}

function clampParam(v: unknown, def: number, min: number, max: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return def;
	return Math.min(max, Math.max(min, Math.round(v)));
}

const MAX_COMMANDS = clampEnv("FC_MAX_COMMANDS", 8, 1, 8);
const TIMEOUT_MS = clampEnv("FC_TIMEOUT_MS", 30000, 5000, 120000);
const REPO_MAP_MODE = process.env.FC_REPO_MAP_MODE === "classic" ? "classic" : "hotspot";
const HOTSPOT_BASE_DEPTH = clampEnv("FC_HOTSPOT_BASE_DEPTH", 1, 1, 4);
const HOTSPOT_TOP_K = clampEnv("FC_HOTSPOT_TOP_K", 4, 1, 10);
const HOTSPOT_TREE_DEPTH = clampEnv("FC_HOTSPOT_TREE_DEPTH", 2, 1, 6);
const HOTSPOT_MAX_BYTES = clampEnv("FC_HOTSPOT_MAX_BYTES", 120 * 1024, 16 * 1024, 250 * 1024);

export interface CodeSearchParams {
	query?: string;
	project_path?: string;
	tree_depth?: number;
	max_turns?: number;
	max_results?: number;
	exclude_paths?: string[];
}

export interface CodeSearchDetails {
	fileCount?: number;
	keywords?: string[];
	errorMessage?: string;
}

export interface CodeSearchOutput {
	text: string;
	details: CodeSearchDetails;
}

export async function runCodeSearch(
	params: CodeSearchParams,
	apiKey: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
): Promise<CodeSearchOutput> {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	if (!query) return { text: "Error: query is required.", details: { errorMessage: "query is required" } };

	let projectRoot = resolve(cwd);
	if (params.project_path) {
		const candidate = isAbsolute(params.project_path)
			? resolve(params.project_path)
			: resolve(cwd, params.project_path);
		if (!new PathSandbox(cwd).contains(candidate)) {
			return {
				text: `Error: project_path must be inside the current working directory.\n[hint] given=${params.project_path}, cwd=${cwd}`,
				details: { errorMessage: "project_path outside cwd" },
			};
		}
		projectRoot = candidate;
	}

	const treeDepth = clampParam(params.tree_depth, 3, 0, 6);
	const maxTurns = clampParam(params.max_turns, 3, 1, 5);
	const maxResults = clampParam(params.max_results, 10, 1, 30);
	const excludePaths = Array.isArray(params.exclude_paths)
		? params.exclude_paths.filter((p): p is string => typeof p === "string")
		: [];

	const result = await search({
		query,
		projectRoot,
		apiKey,
		grepFn: createPiGrepFn(projectRoot),
		maxTurns,
		maxCommands: MAX_COMMANDS,
		maxResults,
		treeDepth,
		timeoutMs: TIMEOUT_MS,
		excludePaths,
		repoMapMode: REPO_MAP_MODE,
		hotspotBaseDepth: HOTSPOT_BASE_DEPTH,
		hotspotTopK: HOTSPOT_TOP_K,
		hotspotTreeDepth: HOTSPOT_TREE_DEPTH,
		hotspotMaxBytes: HOTSPOT_MAX_BYTES,
		signal,
		onProgress,
	});

	const text = formatSearchResult(result, {
		maxTurns,
		maxResults,
		maxCommands: MAX_COMMANDS,
		timeoutMs: TIMEOUT_MS,
		excludePaths,
	});

	const details: CodeSearchDetails = result.error
		? { errorMessage: result.error.split("\n")[0] }
		: {
				fileCount: result.files.length,
				keywords: [...new Set(result.rgPatterns ?? [])].filter((p) => p.length >= 3),
			};

	return { text, details };
}
