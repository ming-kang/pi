/** Shared constants for the /provider extension. */

import type { Api, ModelThinkingLevel } from "@earendil-works/pi-ai";

export const COMMAND_NAME = "provider";
export const COMMAND_DESCRIPTION = "Manage models.json providers: connection, API type, and models";
export const NO_UI_WARNING = "/provider requires interactive TUI mode.";
export const NO_MODELS_FILE_WARNING =
	"models.json is disabled for this runtime (custom SDK configuration), so /provider is unavailable.";

/**
 * API types offered in the single-select list. The four common custom-endpoint
 * protocols come first; the rest follow in stable order. Custom api strings
 * already present in models.json are preserved and appended at render time.
 */
export const API_TYPES: readonly Api[] = [
	"openai-responses",
	"openai-completions",
	"anthropic-messages",
	"google-generative-ai",
	"azure-openai-responses",
	"openai-codex-responses",
	"mistral-conversations",
	"google-vertex",
	"bedrock-converse-stream",
	"pi-messages",
];

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

/** Maximum reference candidates offered by Use Built-in Data. */
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
