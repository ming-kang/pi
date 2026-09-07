import type { Api, Context, Model, ProviderStreams, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { describe, expect, it, vi } from "vitest";
import { BtwAgent } from "../src/extensions/btw/agent.ts";
import { btwModel, btwSnapshot } from "./helpers/btw.ts";

function withoutCacheMarkers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheMarkers);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "cache_control")
				.map(([key, child]) => [key, withoutCacheMarkers(child)]),
		);
	}
	return value;
}

const cases: Array<{ name: string; model: Model<Api>; stream: ProviderStreams["streamSimple"]; cacheKey: boolean }> = [
	{
		name: "OpenAI Responses",
		model: {
			...btwModel,
			provider: "openai",
			api: "openai-responses",
			id: "gpt-4.1",
			baseUrl: "https://api.openai.com/v1",
		},
		stream: responses,
		cacheKey: true,
	},
	{
		name: "OpenAI Completions",
		model: {
			...btwModel,
			provider: "openai",
			api: "openai-completions",
			id: "gpt-4.1",
			baseUrl: "https://api.openai.com/v1",
		},
		stream: completions,
		cacheKey: true,
	},
	{
		name: "Moonshot Completions",
		model: {
			...btwModel,
			provider: "moonshotai",
			api: "openai-completions",
			id: "kimi-k2.5",
			baseUrl: "https://api.moonshot.ai/v1",
		},
		stream: completions,
		cacheKey: false,
	},
	{
		name: "Anthropic Messages",
		model: {
			...btwModel,
			provider: "anthropic",
			api: "anthropic-messages",
			id: "claude-sonnet-4-5",
			baseUrl: "https://api.anthropic.com",
		},
		stream: anthropic,
		cacheKey: false,
	},
];

describe("BTW published provider payloads", () => {
	it.each(cases)(
		"preserves the logical prefix and tool definitions for $name without network requests",
		async ({ model, stream, cacheKey }) => {
			const snapshot = btwSnapshot({ model });
			const payloads: Record<string, unknown>[] = [];
			const fetch = vi.fn<typeof globalThis.fetch>(async () => {
				throw new Error("Network forbidden in this test");
			});
			const capture = (requestModel: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
				stream(requestModel, context, {
					...options,
					apiKey: "offline-fixture-key",
					fetch,
					maxRetries: 0,
					onPayload: (payload) => {
						if (!payload || typeof payload !== "object" || Array.isArray(payload))
							throw new Error("Expected an object payload");
						payloads.push(structuredClone(payload) as Record<string, unknown>);
						throw new Error("Payload captured before sending");
					},
				});
			await capture(
				model,
				{ systemPrompt: snapshot.systemPrompt, tools: snapshot.tools, messages: snapshot.messages },
				{ ...snapshot.streamOptions, reasoning: "high" },
			).result();
			const side = new BtwAgent(snapshot, { streamSimple: capture }, () => {});
			await side.ask("A side question");
			expect(payloads).toHaveLength(2);
			const [mainPayload, sidePayload] = payloads;
			expect(sidePayload.tools).toEqual(mainPayload.tools);
			expect(sidePayload.system).toEqual(mainPayload.system);
			expect(sidePayload.instructions).toEqual(mainPayload.instructions);
			for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "thinking", "reasoning"]) {
				expect(sidePayload[key]).toEqual(mainPayload[key]);
			}
			const field = model.api === "openai-responses" ? "input" : "messages";
			const mainMessages = mainPayload[field] as unknown[];
			const sideMessages = sidePayload[field] as unknown[];
			expect(mainMessages.length).toBeGreaterThan(0);
			expect(withoutCacheMarkers(sideMessages.slice(0, mainMessages.length))).toEqual(
				withoutCacheMarkers(mainMessages),
			);
			expect(JSON.stringify(sideMessages.slice(mainMessages.length))).toContain("A side question");
			if (cacheKey) expect(sidePayload.prompt_cache_key).toBe(snapshot.sessionId);
			else expect(sidePayload.prompt_cache_key).toBeUndefined();
			expect(fetch).not.toHaveBeenCalled();
			side.dispose();
		},
	);
});
