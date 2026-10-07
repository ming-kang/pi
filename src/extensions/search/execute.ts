import { isAbsolute, resolve } from "node:path";
import { clampInt } from "./clamp.ts";
import { formatSearchResult } from "./format.ts";
import { createPiGrepFn } from "./grep-backend.ts";
import { PathSandbox } from "./sandbox.ts";
import { search } from "./search.ts";

/** Fixed loop budget; the tool parameters are the only model-facing knobs. */
const MAX_COMMANDS = 8;
const TIMEOUT_MS = 30_000;

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

	const treeDepth = clampInt(params.tree_depth, 2, 1, 4);
	const maxTurns = clampInt(params.max_turns, 3, 1, 5);
	const maxResults = clampInt(params.max_results, 10, 1, 30);
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
