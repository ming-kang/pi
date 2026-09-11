import { describe, expect, test } from "vitest";
import {
	compatFieldFor,
	compatFieldsForApi,
	validateChatTemplateKwarg,
	validateJsonCompatValue,
} from "../src/extensions/provider/compat-fields.ts";

describe("provider compat field catalog", () => {
	test("maps api families to their public pi-ai compat types", () => {
		const completions = compatFieldsForApi("openai-completions");
		expect(completions.some((field) => field.key === "supportsStore")).toBe(true);
		expect(completions.some((field) => field.key === "thinkingFormat")).toBe(true);

		// The whole Responses family shares the full Responses catalog.
		const responses = compatFieldsForApi("openai-responses");
		expect(compatFieldsForApi("azure-openai-responses")).toEqual(responses);
		expect(compatFieldsForApi("openai-codex-responses")).toEqual(responses);
		expect(responses.some((field) => field.key === "supportsMaxOutputTokens")).toBe(true);

		expect(compatFieldsForApi("anthropic-messages").some((field) => field.key === "allowEmptySignature")).toBe(true);
		expect(compatFieldsForApi("bedrock-converse-stream")).toEqual([
			expect.objectContaining({ key: "supportsStrictMode", kind: "boolean" }),
		]);
		expect(compatFieldsForApi("google-generative-ai")).toEqual([]);
		expect(compatFieldsForApi("pi-messages")).toEqual([]);
	});

	test("enum fields always carry their legal options", () => {
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
			for (const field of compatFieldsForApi(api)) {
				if (field.kind === "enum") expect(field.options?.length ?? 0).toBeGreaterThan(0);
			}
		}
		expect(compatFieldFor("openai-completions", "maxTokensField")?.options).toEqual([
			"max_completion_tokens",
			"max_tokens",
		]);
	});

	test("catalog keys stay within the models.json schema surface", () => {
		// Spot-check against the schema-known keys (see src/core/model-config.ts).
		const completionsKeys = new Set(compatFieldsForApi("openai-completions").map((field) => field.key));
		for (const known of ["supportsStore", "chatTemplateKwargs", "openRouterRouting", "vllmPriority"]) {
			expect(completionsKeys.has(known)).toBe(true);
		}
		expect(completionsKeys.has("allowEmptySignature")).toBe(false); // anthropic-only
	});
});

describe("provider compat value validation", () => {
	test("json fields validate shape, not just JSON.parse success", () => {
		expect(validateJsonCompatValue("openRouterRouting", "{ not json")).toContain("not valid JSON");
		expect(validateJsonCompatValue("openRouterRouting", '["array"]')).toContain("must be a JSON object");
		expect(validateJsonCompatValue("openRouterRouting", '{"nope": true}')).toContain("not a supported field");
		expect(validateJsonCompatValue("openRouterRouting", '{"order": "not-an-array"}')).toContain("must be array");
		expect(validateJsonCompatValue("openRouterRouting", '{"order": ["a"], "zdr": true}')).toBeUndefined();
		expect(validateJsonCompatValue("vercelGatewayRouting", '{"only": ["anthropic"]}')).toBeUndefined();
	});

	test("chat-template kwarg values follow the pi-ai shape", () => {
		expect(validateChatTemplateKwarg("s")).toBeUndefined();
		expect(validateChatTemplateKwarg(3)).toBeUndefined();
		expect(validateChatTemplateKwarg(true)).toBeUndefined();
		expect(validateChatTemplateKwarg(null)).toBeUndefined();
		expect(validateChatTemplateKwarg({ $var: "thinking.enabled" })).toBeUndefined();
		expect(validateChatTemplateKwarg({ $var: "thinking.effort", omitWhenOff: true })).toBeUndefined();
		expect(validateChatTemplateKwarg({ $var: "other" })).toContain("$var");
		expect(validateChatTemplateKwarg({ $var: "thinking.enabled", extra: 1 })).toContain("Only");
		expect(validateChatTemplateKwarg([1])).toContain("must be");
	});
});
