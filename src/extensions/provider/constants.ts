/** Shared constants for the /provider extension. */

import type { Api, ModelThinkingLevel } from "@earendil-works/pi-ai";

export const COMMAND_NAME = "provider";
export const COMMAND_DESCRIPTION = "Manage models.json providers: connection, API type, and models";
export const NO_UI_WARNING = "/provider requires interactive TUI mode.";
export const NO_MODELS_FILE_WARNING =
	"models.json is disabled for this runtime (custom SDK configuration), so /provider is unavailable.";

/**
 * API types offered in the single-select list. The three protocols custom
 * endpoints speak come first, the two in widest use ahead of Chat Completions;
 * the rest follow in stable order. Custom api strings already present in
 * models.json are preserved and appended at render time.
 */
export const API_TYPES: readonly Api[] = [
	"anthropic-messages",
	"openai-responses",
	"openai-completions",
	"google-generative-ai",
	"azure-openai-responses",
	"openai-codex-responses",
	"mistral-conversations",
	"google-vertex",
	"bedrock-converse-stream",
	"pi-messages",
];

/**
 * The endpoint each common API type calls, which is how an endpoint's own docs
 * name its protocol. A neutral fact rather than a recommendation: which one is
 * right depends on the server, not on how popular the protocol is.
 */
const API_TYPE_ENDPOINTS: Readonly<Record<string, string>> = {
	"anthropic-messages": "Anthropic /v1/messages",
	"openai-responses": "OpenAI /v1/responses",
	"openai-completions": "OpenAI /v1/chat/completions",
};

/** Dim note API pickers show beside a common tag. */
export function apiTypeNote(api: string): string | undefined {
	const endpoint = API_TYPE_ENDPOINTS[api];
	return endpoint ? `· ${endpoint}` : undefined;
}

/** Input modality options. Adding a type also requires pi-ai Model.input and the models.json schema to support it. */
export const INPUT_TYPES = ["text", "image"] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** GET {baseUrl}/models limits. */
export const PROBE_LIMITS = {
	timeoutMs: 10_000,
	maxBodyBytes: 4 * 1024 * 1024,
	maxErrorBytes: 4_096,
	maxErrorChars: 400,
	maxModels: 2_000,
	/** Anthropic catalog pages followed through `has_more`, the first page included. */
	maxPages: 5,
} as const;

/** Maximum reference candidates offered by Use built-in data. */
export const MAX_CANDIDATES = 8;

/** Runtime refresh deadline when leaving /provider or after a fetch import. */
export const REFRESH_TIMEOUT_MS = 15_000;

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `1 entry` / `2 entries` — handles the -y → -ies case. */
export function plural(count: number, word: string): string {
	if (count === 1) return word;
	return word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`;
}

/** Compact token count, e.g. `1.0M`; the thresholds match the footer's usage stats. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Display truncate by characters (rows are width-truncated again at render time). */
export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Mask a literal API key for display. Env/command references stay verbatim; the mask is never saved. */
export function maskApiKey(value: string): string {
	if (!value) return value;
	if (value.startsWith("$") || value.startsWith("!")) return value;
	if (value.length <= 8) return "••••••";
	return `••••••${value.slice(-4)}`;
}

/** True when the raw apiKey value is an env/command reference rather than a literal secret. */
export function isApiKeyReference(value: string): boolean {
	return value.startsWith("$") || value.startsWith("!");
}
