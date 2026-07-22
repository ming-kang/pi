import type { ThinkingLevel } from "./constants.ts";

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface RelayModelConfig {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface RelayConfig {
	/** Provider id shown as provider/model (no slashes). */
	id: string;
	baseUrl: string;
	apiKey: string;
	models: RelayModelConfig[];
}

export interface RouterFile {
	version: number;
	relays: RelayConfig[];
}
