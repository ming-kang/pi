import type { ThinkingLevel } from "./constants.ts";

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface CodexModelConfig {
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	verbosity?: "low" | "medium" | "high" | null;
	parallelToolCalls?: boolean;
}

export interface RelayModelConfig {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: ThinkingLevelMap;
	codex?: CodexModelConfig;
	headers?: Record<string, string>;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface RelayConfig {
	/** Provider id shown as provider/model (no slashes). */
	id: string;
	name?: string;
	headers?: Record<string, string>;
	catalog?: "openai" | "codex";
	baseUrl: string;
	apiKey: string;
	models: RelayModelConfig[];
}

export interface RouterFile {
	version: number;
	relays: RelayConfig[];
}
