/**
 * types.ts — Type definitions for web_search extension providers and fusion engine.
 */

export type SearchEngineType = "minimax" | "deepseek" | "dual" | "none";
export type SearchEngineSource = "MiniMax" | "DeepSeek";

export interface ProviderSearchHit {
	title: string;
	url: string;
	snippet?: string;
	date?: string;
}

export interface WebSearchHit extends ProviderSearchHit {
	sources: SearchEngineSource[];
}

export interface WebSearchDetails {
	query: string;
	durationMs: number;
	status: "success" | "error" | "disabled";
	engine: SearchEngineType;
	totalHits: number;
	hits: WebSearchHit[];
	relatedSearches?: string[];
	deepseekSynthesis?: string;
	errorMessage?: string;
}

/**
 * MiniMax search credential. `host` is always present alongside `key` so
 * callers never guard the two separately.
 */
export interface MiniMaxSearchCredential {
	key: string;
	host: string;
}

/**
 * Resolved credentials: presence of a group means that engine is configured,
 * so impossible states (mode without key, key without host) are unrepresentable.
 * Use `configuredEngine()` from auth.ts to derive the SearchEngineType label.
 */
export interface ResolvedSearchCredentials {
	minimax?: MiniMaxSearchCredential;
	deepseek?: { key: string };
}

export interface ProviderSearchResult {
	source: SearchEngineSource;
	hits: ProviderSearchHit[];
	relatedSearches?: string[];
	synthesisText?: string;
}
