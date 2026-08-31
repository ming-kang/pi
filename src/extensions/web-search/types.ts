/**
 * types.ts — Type definitions for web_search extension providers and fusion engine.
 */

export type SearchEngineType = "minimax" | "deepseek" | "dual" | "none";
export type SearchEngineSource = "MiniMax" | "DeepSeek";

export interface WebSearchHit {
	title: string;
	url: string;
	snippet?: string;
	date?: string;
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

export interface ResolvedSearchCredentials {
	minimaxKey?: string;
	minimaxHost?: string;
	deepseekKey?: string;
	mode: SearchEngineType;
}

export interface MiniMaxOrganicHit {
	title: string;
	link: string;
	snippet?: string;
	date?: string;
}

export interface MiniMaxSearchResponse {
	organic?: MiniMaxOrganicHit[];
	related_searches?: { query: string }[];
	base_resp?: {
		status_code: number;
		status_msg: string;
	};
}

export interface DeepSeekServerToolUseBlock {
	type: "server_tool_use";
	id: string;
	name: "web_search";
	input?: { query?: string };
}

export interface DeepSeekWebSearchResultItem {
	type: "web_search_result";
	title: string;
	url: string;
	page_age?: string | null;
	encrypted_content?: string;
}

export interface DeepSeekWebSearchToolResultBlock {
	type: "web_search_tool_result";
	tool_use_id: string;
	content?: DeepSeekWebSearchResultItem[];
}

export interface DeepSeekTextBlock {
	type: "text";
	text?: string;
	citations?: {
		type: string;
		title?: string;
		url?: string;
		cited_text?: string;
	}[];
}

export type DeepSeekContentBlock =
	| DeepSeekServerToolUseBlock
	| DeepSeekWebSearchToolResultBlock
	| DeepSeekTextBlock
	| { type: string; [key: string]: unknown };

export interface DeepSeekMessagesResponse {
	id?: string;
	type?: string;
	role?: string;
	model?: string;
	content?: DeepSeekContentBlock[];
	stop_reason?: string;
	error?: {
		type?: string;
		message?: string;
	};
}

export interface ProviderSearchResult {
	source: SearchEngineSource;
	hits: WebSearchHit[];
	relatedSearches?: string[];
	synthesisText?: string;
}
