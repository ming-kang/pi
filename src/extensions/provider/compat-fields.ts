/**
 * Compat field catalog per effective API, derived from pi-ai's public compat
 * types (OpenAICompletionsCompat / OpenAIResponsesCompat /
 * AnthropicMessagesCompat / BedrockCompat). Endpoints configured through
 * /provider are not Pi builtins, so the catalog lists the full type-level
 * field set without per-implementation filtering.
 */

import type { Api } from "@earendil-works/pi-ai";

export type CompatValueKind = "boolean" | "enum" | "number" | "stringMap" | "json";

export interface CompatField {
	key: string;
	kind: CompatValueKind;
	/** Legal values for enum fields. */
	options?: readonly string[];
	/** Short single-line description shown in the picker. */
	note?: string;
}

const SESSION_AFFINITY = ["openai", "openai-nosession", "openrouter"] as const;

const OPENAI_COMPLETIONS_FIELDS: readonly CompatField[] = [
	{ key: "supportsStore", kind: "boolean", note: "Accepts the `store` parameter" },
	{ key: "supportsDeveloperRole", kind: "boolean", note: "Accepts `developer` role messages" },
	{ key: "supportsReasoningEffort", kind: "boolean", note: "Accepts `reasoning_effort`" },
	{ key: "supportsUsageInStreaming", kind: "boolean", note: "Streams usage chunks" },
	{ key: "supportsFinishReason", kind: "boolean", note: "Reports finish reasons" },
	{
		key: "maxTokensField",
		kind: "enum",
		options: ["max_completion_tokens", "max_tokens"],
		note: "Token limit field name",
	},
	{ key: "requiresToolResultName", kind: "boolean", note: "Tool results need a `name`" },
	{ key: "requiresAssistantAfterToolResult", kind: "boolean", note: "Needs assistant message after tool results" },
	{ key: "requiresThinkingAsText", kind: "boolean", note: "Thinking must be plain text" },
	{
		key: "requiresReasoningContentOnAssistantMessages",
		kind: "boolean",
		note: "Assistant messages must carry reasoning content",
	},
	{
		key: "thinkingFormat",
		kind: "enum",
		options: [
			"openai",
			"openrouter",
			"together",
			"baseten",
			"deepseek",
			"zai",
			"qwen",
			"chat-template",
			"qwen-chat-template",
			"string-thinking",
			"ant-ling",
		],
		note: "Reasoning payload format",
	},
	{ key: "chatTemplateKwargs", kind: "stringMap", note: "Extra chat-template kwargs (open dictionary)" },
	{ key: "chatTemplateArgs", kind: "stringMap", note: "Extra chat-template args (open dictionary)" },
	{ key: "cacheControlFormat", kind: "enum", options: ["anthropic"], note: "Cache-control payload format" },
	{ key: "openRouterRouting", kind: "json", note: "OpenRouter routing preferences object" },
	{ key: "vercelGatewayRouting", kind: "json", note: "Vercel AI Gateway routing object" },
	{ key: "supportsOpenAIGrammarTools", kind: "boolean", note: "Grammar-constrained tool calls" },
	{ key: "supportsStrictMode", kind: "boolean", note: "Strict tool schemas" },
	{ key: "sendSessionAffinityHeaders", kind: "boolean", note: "Send session affinity headers" },
	{ key: "deferredToolsMode", kind: "enum", options: ["kimi"], note: "Deferred tool-call handling" },
	{ key: "sessionAffinityFormat", kind: "enum", options: SESSION_AFFINITY, note: "Affinity header format" },
	{ key: "supportsLongCacheRetention", kind: "boolean", note: "Long-lived prompt cache retention" },
	{ key: "vllmPriority", kind: "number", note: "vLLM scheduling priority" },
];

const OPENAI_RESPONSES_FIELDS: readonly CompatField[] = [
	{ key: "supportsDeveloperRole", kind: "boolean", note: "Accepts `developer` role messages" },
	{ key: "sessionAffinityFormat", kind: "enum", options: SESSION_AFFINITY, note: "Affinity header format" },
	{ key: "supportsLongCacheRetention", kind: "boolean", note: "Long-lived prompt cache retention" },
	{ key: "supportsStrictMode", kind: "boolean", note: "Strict tool schemas" },
	{ key: "supportsOpenAIGrammarTools", kind: "boolean", note: "Grammar-constrained tool calls" },
	{ key: "supportsAdditionalTools", kind: "boolean", note: "Accepts additional hosted tools" },
	{ key: "supportsToolSearch", kind: "boolean", note: "Tool search support" },
	{ key: "supportsMaxOutputTokens", kind: "boolean", note: "Accepts `max_output_tokens`" },
];

const ANTHROPIC_MESSAGES_FIELDS: readonly CompatField[] = [
	{ key: "supportsEagerToolInputStreaming", kind: "boolean", note: "Streams tool input eagerly" },
	{ key: "supportsLongCacheRetention", kind: "boolean", note: "Long-lived prompt cache retention" },
	{ key: "sendSessionAffinityHeaders", kind: "boolean", note: "Send session affinity headers" },
	{ key: "supportsCacheControlOnTools", kind: "boolean", note: "Cache control on tool definitions" },
	{ key: "supportsTemperature", kind: "boolean", note: "Accepts `temperature`" },
	{ key: "forceAdaptiveThinking", kind: "boolean", note: "Force adaptive thinking mode" },
	{ key: "allowEmptySignature", kind: "boolean", note: "Tolerate empty thinking signatures" },
	{ key: "supportsStrictTools", kind: "boolean", note: "Strict tool schemas" },
	{ key: "supportsMidConvoEffort", kind: "boolean", note: "Effort changes mid-conversation" },
	{ key: "supportsToolReferences", kind: "boolean", note: "Tool references support" },
];

const BEDROCK_FIELDS: readonly CompatField[] = [
	{ key: "supportsStrictMode", kind: "boolean", note: "Strict tool schemas" },
];

/** Compat fields known for the given effective api; empty when the API consumes no compat object. */
export function compatFieldsForApi(api: string): readonly CompatField[] {
	switch (api as Api) {
		case "openai-completions":
			return OPENAI_COMPLETIONS_FIELDS;
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return OPENAI_RESPONSES_FIELDS;
		case "anthropic-messages":
			return ANTHROPIC_MESSAGES_FIELDS;
		case "bedrock-converse-stream":
			return BEDROCK_FIELDS;
		default:
			return [];
	}
}

export function compatFieldFor(api: string, key: string): CompatField | undefined {
	return compatFieldsForApi(api).find((field) => field.key === key);
}

/** Allowed top-level keys for JSON-shaped compat fields; validates shape, not just JSON.parse success. */
const JSON_FIELD_SHAPES: Record<
	string,
	Record<string, "boolean" | "string" | "number" | "array" | "object" | "any">
> = {
	openRouterRouting: {
		allow_fallbacks: "boolean",
		require_parameters: "boolean",
		data_collection: "string",
		zdr: "boolean",
		enforce_distillable_text: "boolean",
		order: "array",
		only: "array",
		ignore: "array",
		quantizations: "array",
		sort: "any",
		max_price: "object",
		preferred_min_throughput: "any",
		preferred_max_latency: "any",
	},
	vercelGatewayRouting: { only: "array", order: "array" },
};

/** Validate a JSON-text value for a json-kind compat field. Returns an error message or undefined. */
export function validateJsonCompatValue(key: string, text: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "Value is not valid JSON.";
	}
	const shape = JSON_FIELD_SHAPES[key];
	if (!shape) return undefined;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return `${key} must be a JSON object.`;
	for (const [entryKey, entryValue] of Object.entries(parsed as Record<string, unknown>)) {
		const expected = shape[entryKey];
		if (!expected) return `${key}.${entryKey} is not a supported field.`;
		if (expected === "any") continue;
		const actual = Array.isArray(entryValue) ? "array" : entryValue === null ? "null" : typeof entryValue;
		if (expected === "object" ? actual !== "object" : actual !== expected) {
			return `${key}.${entryKey} must be ${expected}, got ${actual}.`;
		}
	}
	return undefined;
}

/** Chat-template kwarg scalar or {$var} reference, per pi-ai's ChatTemplateKwarg type. */
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| { $var: "thinking.enabled" | "thinking.effort"; omitWhenOff?: boolean };

/** Validate one open-dictionary value for chatTemplateKwargs/chatTemplateArgs. */
export function validateChatTemplateKwarg(value: unknown): string | undefined {
	if (value === null) return undefined;
	const kind = typeof value;
	if (kind === "string" || kind === "number" || kind === "boolean") return undefined;
	if (kind === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (record.$var !== "thinking.enabled" && record.$var !== "thinking.effort") {
			return 'Object values must be { "$var": "thinking.enabled" | "thinking.effort" }.';
		}
		if (!keys.every((key) => key === "$var" || key === "omitWhenOff")) {
			return 'Only "$var" and "omitWhenOff" are allowed.';
		}
		if (record.omitWhenOff !== undefined && typeof record.omitWhenOff !== "boolean") {
			return "omitWhenOff must be a boolean.";
		}
		return undefined;
	}
	return "Value must be a string, number, boolean, null, or a $var reference.";
}
