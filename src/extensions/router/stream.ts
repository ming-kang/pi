/**
 * Codex-oriented Responses client for API relays.
 *
 * Follows Pi's documented custom-provider pattern (see coding-agent docs
 * providers.md / custom-provider.md and examples/custom-provider-gitlab-duo):
 * wrap a built-in pi-ai stream API from `@earendil-works/pi-ai/compat` instead of
 * reimplementing SSE or deep-importing internal modules.
 *
 * We use openAIResponsesApi (works with relay sk- keys) and reshape the request
 * payload toward Codex CLI style so transparent gateways receive a friendlier body.
 */

import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	openAIResponsesApi,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

import { DEFAULTS, formatError, ROUTER_API } from "./constants.ts";

const responsesApi = openAIResponsesApi();

export function streamRouterCodex(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			// Built-in Responses stream expects api "openai-responses" on the model object.
			const requestModel = {
				...model,
				api: "openai-responses" as const,
				compat: {
					supportsDeveloperRole: true,
					// Avoid underscore session_id header that strict proxies reject.
					sessionAffinityFormat: "openai-nosession" as const,
					// Codex-style upstreams reject prompt_cache_retention: "24h".
					supportsLongCacheRetention: false,
					...(model.compat ?? {}),
				},
			} as Model<"openai-responses">;

			const headers: Record<string, string> = {
				originator: DEFAULTS.originator,
				...(options?.headers as Record<string, string> | undefined),
			};

			// Prefer hyphenated Codex-style session affinity when we have a session id.
			const sessionId = clampCacheKey(options?.sessionId);
			if (sessionId) {
				if (!headers["session-id"]) headers["session-id"] = sessionId;
				if (!headers["x-client-request-id"]) headers["x-client-request-id"] = sessionId;
			}

			const inner = responsesApi.streamSimple(requestModel, context, {
				...options,
				apiKey,
				headers,
				onPayload: (payload) => reshapePayloadForRelay(payload, context, options?.onPayload, requestModel),
			});

			for await (const event of inner) {
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			// Match examples/custom-provider-gitlab-duo error event shape.
			stream.push({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: formatError(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

/**
 * Nudge the OpenAI Responses payload toward Codex CLI request shape for
 * transparent relays: instructions + input, store:false, no max_output_tokens /
 * prompt_cache_retention, verbosity + parallel_tool_calls.
 */
async function reshapePayloadForRelay(
	payload: unknown,
	context: Context,
	userOnPayload: SimpleStreamOptions["onPayload"],
	model: Model<"openai-responses">,
): Promise<unknown> {
	const base =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? { ...(payload as Record<string, unknown>) }
			: ({} as Record<string, unknown>);

	// Always safe for ChatGPT/Codex-style backends.
	base.store = false;
	base.stream = true;

	// Codex CLI sends system prompt as `instructions`, not as a role message in input.
	const { instructions, input } = extractInstructions(base.input, context.systemPrompt);
	if (instructions) base.instructions = instructions;
	if (input !== undefined) base.input = input;

	// Fields common on Codex CLI / rejected by many transparent Codex upstreams.
	if (!base.text || typeof base.text !== "object") {
		base.text = { verbosity: "low" };
	}
	if (base.tool_choice === undefined) base.tool_choice = "auto";
	if (base.parallel_tool_calls === undefined) base.parallel_tool_calls = true;

	// Prefer encrypted reasoning content for multi-turn store:false sessions.
	const include = Array.isArray(base.include) ? [...(base.include as unknown[])] : [];
	if (!include.includes("reasoning.encrypted_content")) {
		include.push("reasoning.encrypted_content");
	}
	base.include = include;

	// Drop Platform-only fields that Codex OAuth endpoints often 400 on.
	delete base.prompt_cache_retention;
	delete base.max_output_tokens;
	delete base.temperature;
	delete base.top_p;
	delete base.user;
	delete base.metadata;
	delete base.service_tier;
	delete base.truncation;
	delete base.context_management;
	delete base.safety_identifier;
	delete base.stream_options;

	if (userOnPayload) {
		const next = await userOnPayload(base, model);
		if (next !== undefined) return next;
	}
	return base;
}

function extractInstructions(
	input: unknown,
	systemPrompt: string | undefined,
): { instructions?: string; input: unknown } {
	// Prefer context.systemPrompt (matches Codex stream path).
	if (systemPrompt && systemPrompt.length > 0) {
		const stripped = stripLeadingSystemRoles(input);
		return { instructions: systemPrompt, input: stripped ?? input };
	}

	if (!Array.isArray(input) || input.length === 0) {
		return { input };
	}

	const first = input[0];
	if (
		first &&
		typeof first === "object" &&
		!Array.isArray(first) &&
		"role" in first &&
		((first as { role?: string }).role === "system" || (first as { role?: string }).role === "developer")
	) {
		const content = (first as { content?: unknown }).content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) =>
								part && typeof part === "object" && "text" in part
									? String((part as { text: unknown }).text)
									: "",
							)
							.join("")
					: "";
		return {
			instructions: text || undefined,
			input: input.slice(1),
		};
	}

	return { input };
}

function stripLeadingSystemRoles(input: unknown): unknown {
	if (!Array.isArray(input) || input.length === 0) return input;
	const first = input[0];
	if (
		first &&
		typeof first === "object" &&
		!Array.isArray(first) &&
		((first as { role?: string }).role === "system" || (first as { role?: string }).role === "developer")
	) {
		return input.slice(1);
	}
	return input;
}

function clampCacheKey(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	return sessionId.length <= 64 ? sessionId : sessionId.slice(0, 64);
}

export function resolveResponsesUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) throw new Error("Model baseUrl is empty.");
	if (normalized.endsWith("/responses")) return normalized;
	return `${normalized}/responses`;
}

export function isRouterApi(api: string): boolean {
	return api === ROUTER_API;
}
