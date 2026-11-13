/**
 * Compat field catalog per effective API, derived from pi-ai's public
 * CompatSchemasByApi (the per-API compat JSON Schemas published by
 * @earendil-works/pi-ai/providers/compat-schema). Each schema is a JSON Schema
 * object: booleans/numbers, enums as `const`/`anyOf` string consts, open
 * dictionaries as `patternProperties`, and structured routing objects/arrays as
 * plain objects/arrays. Any API added to CompatSchemasByApi is catalogued
 * automatically. Existing foreign fields are preserved by the editor and
 * validated leniently (the schemas allow additional properties).
 */

import type { ChatTemplateKwargValue } from "@earendil-works/pi-ai";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import { Compile } from "typebox/compile";

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

/** The subset of JSON Schema the compat schemas actually use. */
interface JsonSchema {
	type?: string;
	const?: unknown;
	properties?: Record<string, JsonSchema>;
	patternProperties?: Record<string, JsonSchema>;
	anyOf?: JsonSchema[];
	description?: string;
}

function apiSchema(api: string): JsonSchema | undefined {
	return (CompatSchemasByApi as Record<string, JsonSchema | undefined>)[api];
}

/**
 * Concise UI notes kept over the schema's own (longer) description; any field
 * without an entry here falls back to its schema description.
 */
const FIELD_NOTES: Record<string, string> = {
	supportsStore: "Accepts the `store` parameter",
	supportsDeveloperRole: "Accepts `developer` role messages",
	supportsReasoningEffort: "Accepts `reasoning_effort`",
	supportsUsageInStreaming: "Streams usage chunks",
	supportsFinishReason: "Reports finish reasons",
	maxTokensField: "Token limit field name",
	requiresToolResultName: "Tool results need a `name`",
	requiresAssistantAfterToolResult: "Needs assistant message after tool results",
	requiresThinkingAsText: "Thinking must be plain text",
	requiresReasoningContentOnAssistantMessages: "Assistant messages must carry reasoning content",
	thinkingFormat: "Reasoning payload format",
	chatTemplateKwargs: "Extra chat-template kwargs (open dictionary)",
	chatTemplateArgs: "Extra chat-template args (open dictionary)",
	cacheControlFormat: "Cache-control payload format",
	openRouterRouting: "OpenRouter routing preferences object",
	vercelGatewayRouting: "Vercel AI Gateway routing object",
	supportsOpenAIGrammarTools: "Grammar-constrained tool calls",
	supportsStrictMode: "Strict tool schemas",
	sendSessionAffinityHeaders: "Send session affinity headers",
	supportsMidConvoSystemMessages: "Accepts mid-conversation system messages",
	supportsMidConvoToolAdditions: "System messages can add tools mid-conversation",
	sessionAffinityFormat: "Affinity header format",
	supportsLongCacheRetention: "Long-lived prompt cache retention",
	vllmPriority: "vLLM scheduling priority",
	zaiToolStream: "Z.AI streaming tool calls",
	supportsThinkingTokenBudget: "Enable the thinking-token budget alias",
	thinkingTokenBudgetField: "Thinking budget field",
	supportsAdditionalTools: "Accepts additional hosted tools",
	supportsToolSearch: "Tool search support",
	supportsMaxOutputTokens: "Accepts `max_output_tokens`",
	supportsExplicitPromptCacheMode: "Explicit prompt caching",
	supportsEagerToolInputStreaming: "Streams tool input eagerly",
	supportsCacheControlOnTools: "Cache control on tool definitions",
	supportsTemperature: "Accepts `temperature`",
	forceAdaptiveThinking: "Force adaptive thinking mode",
	allowEmptySignature: "Tolerate empty thinking signatures",
	supportsStrictTools: "Strict tool schemas",
	supportsMidConvoEffort: "Effort changes mid-conversation",
	supportsMidConvoToolChanges: "Accepts mid-conversation tool changes",
	allowedFallbackModels: "Server-side refusal fallback models",
};

/** Enum options from a `const` string or an all-`const` `anyOf`; undefined otherwise. */
function enumOptionsOf(schema: JsonSchema): readonly string[] | undefined {
	if (schema.type === "string" && typeof schema.const === "string") return [schema.const];
	if (Array.isArray(schema.anyOf)) {
		const options = schema.anyOf
			.filter((entry) => entry.type === "string" && typeof entry.const === "string")
			.map((entry) => entry.const as string);
		if (options.length > 0 && options.length === schema.anyOf.length) return options;
	}
	return undefined;
}

function scalarKind(schema: JsonSchema): Exclude<CompatValueKind, "enum"> {
	if (schema.type === "boolean") return "boolean";
	if (schema.type === "number" || schema.type === "integer") return "number";
	// Open dictionaries (chatTemplateKwargs/chatTemplateArgs) open one nesting level.
	if (schema.type === "object" && schema.patternProperties !== undefined) return "stringMap";
	return "json";
}

function fieldFor(key: string, schema: JsonSchema): CompatField {
	const note = FIELD_NOTES[key] ?? schema.description;
	const options = enumOptionsOf(schema);
	if (options !== undefined)
		return note === undefined ? { key, kind: "enum", options } : { key, kind: "enum", options, note };
	const kind = scalarKind(schema);
	return note === undefined ? { key, kind } : { key, kind, note };
}

/** Compat fields known for the given effective api; empty when the API consumes no compat object. */
export function compatFieldsForApi(api: string): readonly CompatField[] {
	const properties = apiSchema(api)?.properties;
	if (!properties) return [];
	return Object.entries(properties).map(([key, property]) => fieldFor(key, property));
}

export function compatFieldFor(api: string, key: string): CompatField | undefined {
	return compatFieldsForApi(api).find((field) => field.key === key);
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

type CompatValidator = ReturnType<typeof Compile>;

/** The first validation errors as a readable string; names the missing required property. */
function firstErrors(validator: CompatValidator, value: unknown): string | undefined {
	if (validator.Check(value)) return undefined;
	return validator
		.Errors(value)
		.slice(0, 5)
		.map((error) => {
			const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			// Name the missing property itself, as models.json load errors do.
			const required =
				error.keyword === "required"
					? (error.params as { requiredProperties?: string[] }).requiredProperties?.[0]
					: undefined;
			const field = required ? (path ? `${path}.${required}` : required) : path || "root";
			return `${field}: ${error.message}`;
		})
		.join("; ");
}

const validatorCache = new Map<string, CompatValidator>();

/** Validate `value` against the effective api's compat schema; unknown apis accept anything. */
function validateAgainst(api: string | undefined, value: unknown): string | undefined {
	if (api === undefined) return undefined;
	const schema = apiSchema(api);
	if (schema === undefined) return undefined;
	let validator = validatorCache.get(api);
	if (!validator) {
		validator = Compile(schema);
		validatorCache.set(api, validator);
	}
	return firstErrors(validator, value);
}

/** Parse a JSON value and validate it against the effective api's compat schema (nested included). */
export function validateJsonCompatValue(api: string | undefined, key: string, text: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "Value is not valid JSON.";
	}
	return validateAgainst(api, { [key]: value });
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
	const error = validateAgainst("openai-completions", { chatTemplateKwargs: { value } });
	return error ? `Value must be a scalar or valid $var reference: ${error}` : undefined;
}
