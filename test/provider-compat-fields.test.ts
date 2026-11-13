import { describe, expect, test } from "vitest";
import {
	compatFieldFor,
	compatFieldsForApi,
	validateChatTemplateKwarg,
	validateJsonCompatValue,
} from "../src/extensions/provider/compat-fields.ts";

describe("provider compat field catalog", () => {
	test("maps api families to their public pi-ai compat schemas", () => {
		const completions = compatFieldsForApi("openai-completions");
		expect(completions.some((field) => field.key === "supportsStore")).toBe(true);
		expect(completions.some((field) => field.key === "thinkingFormat")).toBe(true);

		// Azure and Codex reuse the shared Responses compat schema, so their catalogs match it.
		const responses = compatFieldsForApi("openai-responses").map((field) => field.key);
		expect(compatFieldsForApi("azure-openai-responses").map((field) => field.key)).toEqual(responses);
		expect(compatFieldsForApi("openai-codex-responses").map((field) => field.key)).toEqual(responses);
		expect(responses).toContain("supportsMaxOutputTokens");
		expect(responses).toContain("supportsAdditionalTools");

		expect(compatFieldsForApi("anthropic-messages").some((field) => field.key === "allowEmptySignature")).toBe(true);
		expect(compatFieldsForApi("bedrock-converse-stream")).toEqual([
			expect.objectContaining({ key: "supportsStrictMode", kind: "boolean" }),
		]);
		expect(compatFieldsForApi("google-generative-ai")).toEqual([]);
		expect(compatFieldsForApi("pi-messages")).toEqual([]);
	});

	test("catalogues newly added apis automatically from their schema", () => {
		// These APIs are only present as CompatSchemasByApi keys; no per-api wiring exists.
		expect(compatFieldsForApi("mistral-conversations").map((field) => field.key)).toEqual([
			"supportsMidConvoSystemMessages",
		]);
		const systemOne = compatFieldsForApi("typesafe-system-one");
		expect(systemOne.map((field) => field.key).sort()).toEqual(["imageInput", "sendImageOptInHeader"]);
		const imageInput = compatFieldFor("typesafe-system-one", "imageInput");
		expect(imageInput?.kind === "enum" ? imageInput.options : []).toEqual(["assets", "images", "state-image-urls"]);
	});

	test("derives kinds from the schema shape", () => {
		expect(compatFieldFor("openai-completions", "supportsStore")?.kind).toBe("boolean");
		expect(compatFieldFor("openai-completions", "vllmPriority")?.kind).toBe("number");
		expect(compatFieldFor("openai-completions", "maxTokensField")?.kind).toBe("enum");
		expect(compatFieldFor("openai-completions", "openRouterRouting")?.kind).toBe("json");
		expect(compatFieldFor("anthropic-messages", "allowedFallbackModels")?.kind).toBe("json");
		// Open dictionaries keep their UI-specific classification and concise note.
		expect(compatFieldFor("openai-completions", "chatTemplateKwargs")?.kind).toBe("stringMap");
		expect(compatFieldFor("openai-completions", "chatTemplateArgs")?.note).toBe(
			"Extra chat-template args (open dictionary)",
		);
		expect(compatFieldFor("openai-completions", "supportsStore")?.note).toBe("Accepts the `store` parameter");
		// Fields the catalog never curated fall back to the schema description.
		expect(compatFieldFor("openai-completions", "requiresNonNullAssistantContent")?.note).toContain("null content");
	});

	test("enum fields always carry their legal options", () => {
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
			for (const field of compatFieldsForApi(api)) {
				if (field.kind === "enum") expect(field.options?.length ?? 0).toBeGreaterThan(0);
			}
		}
		const tokensField = compatFieldFor("openai-completions", "maxTokensField");
		expect(tokensField?.kind === "enum" ? tokensField.options : []).toEqual(["max_completion_tokens", "max_tokens"]);
	});
});

describe("provider compat value validation", () => {
	test("json fields validate shape, not just JSON.parse success", () => {
		expect(validateJsonCompatValue("openai-completions", "openRouterRouting", "{ not json")).toContain(
			"not valid JSON",
		);
		expect(validateJsonCompatValue("openai-completions", "openRouterRouting", '["array"]')).toBeDefined();
		// Unknown fields round-trip under the native configuration contract.
		expect(
			validateJsonCompatValue("openai-completions", "openRouterRouting", '{"futureField": true}'),
		).toBeUndefined();
		expect(
			validateJsonCompatValue("openai-completions", "openRouterRouting", '{"order": "not-an-array"}'),
		).toBeDefined();
		expect(validateJsonCompatValue("openai-completions", "openRouterRouting", '{"order": [123]}')).toBeDefined();
		expect(
			validateJsonCompatValue("openai-completions", "openRouterRouting", '{"data_collection": "invalid"}'),
		).toBeDefined();
		expect(
			validateJsonCompatValue("openai-completions", "openRouterRouting", '{"order": ["a"], "zdr": true}'),
		).toBeUndefined();
		expect(
			validateJsonCompatValue("openai-completions", "vercelGatewayRouting", '{"only": ["anthropic"]}'),
		).toBeUndefined();
	});

	test("json fields validate against the effective api, not always completions", () => {
		// allowedFallbackModels is anthropic-only: validated by the anthropic schema, which the
		// completions schema would treat as a foreign property and never check.
		expect(
			validateJsonCompatValue("anthropic-messages", "allowedFallbackModels", '{"not":"an-array"}'),
		).toBeDefined();
		expect(
			validateJsonCompatValue("anthropic-messages", "allowedFallbackModels", '[{"provider":"p","model":"m"}]'),
		).toBeDefined();
		expect(
			validateJsonCompatValue(
				"anthropic-messages",
				"allowedFallbackModels",
				'[{"provider":"p","model":"m","cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}}]',
			),
		).toBeUndefined();
		// The same value on a completions model is foreign and preserved without shape checks.
		expect(
			validateJsonCompatValue("openai-completions", "allowedFallbackModels", '{"anything":true}'),
		).toBeUndefined();
		// An unresolved api has no schema to validate against, so it accepts the value.
		expect(validateJsonCompatValue(undefined, "allowedFallbackModels", '{"anything":true}')).toBeUndefined();
	});

	test("chat-template kwarg values follow the pi-ai shape", () => {
		expect(validateChatTemplateKwarg("s")).toBeUndefined();
		expect(validateChatTemplateKwarg(3)).toBeUndefined();
		expect(validateChatTemplateKwarg(true)).toBeUndefined();
		expect(validateChatTemplateKwarg(null)).toBeUndefined();
		expect(validateChatTemplateKwarg({ $var: "thinking.enabled" })).toBeUndefined();
		expect(validateChatTemplateKwarg({ $var: "thinking.budget" })).toBeUndefined();
		expect(validateChatTemplateKwarg(Number.POSITIVE_INFINITY)).toBeDefined();
		expect(validateChatTemplateKwarg({ $var: "thinking.effort", omitWhenOff: true })).toBeUndefined();
		expect(validateChatTemplateKwarg({ $var: "other" })).toContain("$var");
		expect(validateChatTemplateKwarg({ $var: "thinking.enabled", extra: 1 })).toContain("Only");
		expect(validateChatTemplateKwarg([1])).toContain("must be");
	});
});
