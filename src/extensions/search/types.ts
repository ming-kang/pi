/** The code-search loop's data contract: what a caller asks for, and what the loop hands back. */
import type { GrepFn } from "./executor.ts";

export interface SearchOptions {
	query: string;
	projectRoot: string;
	apiKey: string;
	grepFn: GrepFn;
	maxTurns?: number;
	maxCommands?: number;
	maxResults?: number;
	treeDepth?: number;
	timeoutMs?: number;
	excludePaths?: string[];
	onProgress?: (msg: string) => void;
	signal?: AbortSignal;
}

/** A file the backend nominated, already verified to sit inside the sandbox. */
export interface SearchFile {
	path: string;
	fullPath: string;
	ranges: Array<[number, number]>;
}

/** What the loop did, echoed into the result so a caller can explain a weak or failed search. */
export interface SearchMeta {
	treeDepth: number;
	treeSizeKB: number;
	fellBack: boolean;
	strategy?: "hotspot";
	hotDirs?: string[];
	hotspotDepth?: number;
	errorCode?: string;
	contextTrimmed?: boolean;
}

export interface SearchResult {
	files: SearchFile[];
	rgPatterns?: string[];
	error?: string;
	rawResponse?: string;
	meta?: SearchMeta;
}
