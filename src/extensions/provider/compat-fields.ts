/**
 * Compat field catalog per effective API, derived from pi-ai's public compat
 * types (OpenAICompletionsCompat / OpenAIResponsesCompat /
 * AnthropicMessagesCompat / BedrockCompat). Each API variant exposes only the settings consumed by its published
 * implementation; existing foreign fields are preserved by the editor.
 */

import type {
	AnthropicMessagesCompat,
	BedrockCompat,
	ChatTemplateKwargValue,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "@earendil-works/pi-ai";
import { ModelConfig } from "../../core/model-config.ts";

export type CompatValueKind = "boolean" | "enum" | "number" | "stringMap" | "json";

export type CompatField<Key extends string = string> = {
	key: Key;
	note?: string;
} & ({ kind: "enum"; options: readonly string[] } | { kind: Exclude<CompatValueKind, "enum"> });

export const THINKING_VARIABLES = [
	"thinking.enabled",
	"thinking.effort",
	"thinking.budget",
] as const satisfies readonly Extract<ChatTemplateKwargValue, { $var: string }>["$var"][];

const SESSION_AFFINITY = ["openai", "openai-nosession", "openrouter"] as const;

const OPENAI_COMPLETIONS_FIELDS: readonly CompatField<keyof OpenAICompletionsCompat>[] = [
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
	{ key: "zaiToolStream", kind: "boolean", note: "Z.AI streaming tool calls" },
	{ key: "supportsThinkingTokenBudget", kind: "boolean", note: "Enable the thinking-token budget alias" },
	{
		key: "thinkingTokenBudgetField",
		kind: "enum",
		options: ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"],
		note: "Thinking budget field",
	},
];

const OPENAI_RESPONSES_FIELDS: readonly CompatField<keyof OpenAIResponsesCompat>[] = [
	{ key: "supportsDeveloperRole", kind: "boolean", note: "Accepts `developer` role messages" },
	{ key: "sessionAffinityFormat", kind: "enum", options: SESSION_AFFINITY, note: "Affinity header format" },
	{ key: "supportsLongCacheRetention", kind: "boolean", note: "Long-lived prompt cache retention" },
	{ key: "supportsStrictMode", kind: "boolean", note: "Strict tool schemas" },
	{ key: "supportsOpenAIGrammarTools", kind: "boolean", note: "Grammar-constrained tool calls" },
	{ key: "supportsAdditionalTools", kind: "boolean", note: "Accepts additional hosted tools" },
	{ key: "supportsToolSearch", kind: "boolean", note: "Tool search support" },
	{ key: "supportsMaxOutputTokens", kind: "boolean", note: "Accepts `max_output_tokens`" },
	{ key: "supportsExplicitPromptCacheMode", kind: "boolean", note: "Explicit prompt caching" },
];

const ANTHROPIC_MESSAGES_FIELDS: readonly CompatField<keyof AnthropicMessagesCompat>[] = [
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

const BEDROCK_FIELDS: readonly CompatField<keyof BedrockCompat>[] = [
	{ key: "supportsStrictMode", kind: "boolean", note: "Strict tool schemas" },
];

/** Compat fields known for the given effective api; empty when the API consumes no compat object. */
export function compatFieldsForApi(api: string): readonly CompatField[] {
	switch (api) {
		case "openai-completions":
			return OPENAI_COMPLETIONS_FIELDS;
		case "openai-responses":
			return OPENAI_RESPONSES_FIELDS;
		case "azure-openai-responses":
			return OPENAI_RESPONSES_FIELDS.filter((field) =>
				["supportsDeveloperRole", "supportsStrictMode", "supportsOpenAIGrammarTools"].includes(field.key),
			);
		case "openai-codex-responses":
			return OPENAI_RESPONSES_FIELDS.filter((field) =>
				[
					"supportsStrictMode",
					"supportsOpenAIGrammarTools",
					"supportsAdditionalTools",
					"supportsToolSearch",
				].includes(field.key),
			);
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

/** Parse JSON values and reuse the canonical models.json schema, including nested validation. */
export function validateJsonCompatValue(key: string, text: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "Value is not valid JSON.";
	}
	return ModelConfig.validateCompat("openai-completions", { [key]: value });
}

/** Chat-template values share the core schema and the published pi-ai value contract. */
export function validateChatTemplateKwarg(value: unknown): string | undefined {
	if (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!Object.keys(value).every((key) => key === "$var" || key === "omitWhenOff")
	) {
		return 'Only "$var" and "omitWhenOff" are allowed.';
	}
	const error = ModelConfig.validateCompat("openai-completions", { chatTemplateKwargs: { value } });
	return error ? `Value must be a scalar or valid $var reference: ${error}` : undefined;
}
