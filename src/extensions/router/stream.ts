/** Codex 0.153.4 normal Responses/SSE request adaptation; pi-ai owns conversion and stream parsing. */
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type FetchFunction,
	type Model,
	openAIResponsesApi,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { formatError, ROUTER_API } from "./constants.ts";
import { buildCodexHeaders, createCodexFetch } from "./identity.ts";
import { type CodexRequestSnapshot, RouterRequestState } from "./state.ts";
import { createCodexTransport } from "./transport.ts";
import type { CodexModelConfig } from "./types.ts";

const responsesApi = openAIResponsesApi();

export function streamRouterCodex(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	configuration?: { state?: RouterRequestState; codex?: CodexModelConfig },
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const baseUrl = new URL(model.baseUrl);
			if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.hash) {
				throw new Error("Router base URL must be HTTP(S) without embedded credentials or a fragment.");
			}
			const query = baseUrl.search;
			baseUrl.search = "";
			const requestModel = {
				...model,
				baseUrl: baseUrl.href.replace(/\/+$/, ""),
				api: ROUTER_API,
				compat: {
					...(model.compat ?? {}),
					sessionAffinityFormat: "openai-nosession",
					supportsLongCacheRetention: false,
					supportsMaxOutputTokens: false,
				},
			} as Model<"openai-responses">;
			const snapshot = (configuration?.state ?? new RouterRequestState()).request(
				model,
				context,
				options?.sessionId,
			);
			const headers = buildCodexHeaders({ ...snapshot.headers, ...options?.headers });
			const codexFetch = createCodexFetch(options?.fetch);
			// OpenAI SDK concatenates baseURL and /responses before parsing. Keep query parameters
			// out of that concatenation, then restore them at the scoped HTTP boundary.
			const send: FetchFunction = (input, init) => {
				if (!query) return codexFetch(input, init);
				const url = new URL(input instanceof Request ? input.url : String(input));
				url.search = query;
				return codexFetch(input instanceof Request ? new Request(url, input) : url, init);
			};
			const fetch = createCodexTransport(send, {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
				onErrorResponse: async (response) => {
					const responseHeaders: Record<string, string> = {};
					response.headers.forEach((value, name) => {
						responseHeaders[name] = value;
					});
					await options?.onResponse?.({ status: response.status, headers: responseHeaders }, requestModel);
				},
			});
			const inner = responsesApi.streamSimple(requestModel, context, {
				...options,
				apiKey,
				headers,
				fetch,
				// Own only Codex HTTP retry policy. Disable the adapter's different HTTP retry layer.
				maxRetries: 0,
				onPayload: async (payload) => {
					const shaped = reshapePayloadForCodex(payload, context, requestModel, snapshot, configuration?.codex);
					const replacement = await options?.onPayload?.(shaped, requestModel);
					return replacement === undefined ? shaped : replacement;
				},
				onResponse: async (response, responseModel) => {
					snapshot.acceptResponse(response);
					await options?.onResponse?.(response, responseModel);
				},
			});
			for await (const event of inner) stream.push(event);
			stream.end();
		} catch (error) {
			const reason = options?.signal?.aborted ? "aborted" : "error";
			stream.push({
				type: "error",
				reason,
				error: {
					role: "assistant",
					content: [],
					api: ROUTER_API,
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
					stopReason: reason,
					errorMessage: formatError(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();
	return stream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function reshapePayloadForCodex(
	payload: unknown,
	context: Context,
	model: Model<"openai-responses">,
	snapshot: CodexRequestSnapshot,
	configuration: CodexModelConfig = {},
): Record<string, unknown> {
	if (!isRecord(payload)) throw new Error("Responses payload must be an object.");
	// Do not mutate signatures/history or the adapter's original payload.
	const base = structuredClone(payload);
	const { instructions, input } = extractInstructions(base.input, context.systemPrompt);
	if (instructions) base.instructions = instructions;
	else delete base.instructions;
	base.input = input;
	sanitizeInputItemsForCodex(base.input);
	base.store = false;
	base.stream = true;
	base.tools ??= [];
	base.tool_choice = "auto";
	base.parallel_tool_calls = configuration.parallelToolCalls ?? true;
	base.include = ["reasoning.encrypted_content"];
	base.prompt_cache_key = snapshot.promptCacheKey;
	base.client_metadata = snapshot.clientMetadata;

	const reasoning = model.reasoning && isRecord(base.reasoning) ? base.reasoning : {};
	// Summary/verbosity support comes from catalog metadata or explicit model settings, not its id.
	const summary =
		configuration.reasoningSummary === undefined ? (model.reasoning ? "auto" : null) : configuration.reasoningSummary;
	if (summary !== null) reasoning.summary = summary;
	else delete reasoning.summary;
	if (reasoning.effort === "persistent") reasoning.effort = "disabled";
	base.reasoning = reasoning;
	const text = isRecord(base.text) ? base.text : {};
	if (configuration.verbosity != null) text.verbosity = configuration.verbosity;
	else delete text.verbosity;
	if (Object.keys(text).length) base.text = text;
	else delete base.text;

	// These are absent from normal Codex Responses DTOs. maxTokens remains local model metadata.
	for (const name of [
		"prompt_cache_retention",
		"prompt_cache_options",
		"max_output_tokens",
		"temperature",
		"top_p",
		"user",
		"metadata",
		"truncation",
		"context_management",
		"safety_identifier",
		"stream_options",
	])
		delete base[name];
	return base;
}

const RESPONSE_ITEM_ID_TYPES = new Set([
	"additional_tools",
	"message",
	"agent_message",
	"reasoning",
	"local_shell_call",
	"function_call",
	"tool_search_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"tool_search_output",
	"web_search_call",
	"image_generation_call",
	"compaction",
	"compaction_summary",
	"context_compaction",
]);
const STATUS_LESS_ITEM_TYPES = new Set([
	"message",
	"reasoning",
	"function_call",
	"function_call_output",
	"custom_tool_call_output",
]);

/** Codex0.153.4 ResponseItemId::is_prefixed checks only nonempty sides of the first underscore. */
export function sanitizeInputItemsForCodex(input: unknown): void {
	if (!Array.isArray(input)) return;
	for (const item of input) {
		if (!isRecord(item)) continue;
		if (item.type === undefined && typeof item.role === "string") item.type = "message";
		const type = typeof item.type === "string" ? item.type : undefined;
		if (type && RESPONSE_ITEM_ID_TYPES.has(type) && typeof item.id === "string") {
			const separator = item.id.indexOf("_");
			if (separator <= 0 || separator === item.id.length - 1) delete item.id;
		}
		if (type && STATUS_LESS_ITEM_TYPES.has(type)) delete item.status;
		if (Array.isArray(item.content)) {
			for (const part of item.content) {
				if (isRecord(part) && part.type === "output_text") delete part.annotations;
			}
		}
	}
}

function extractInstructions(
	input: unknown,
	systemPrompt: string | undefined,
): { instructions?: string; input: unknown } {
	if (!Array.isArray(input)) return { instructions: systemPrompt, input };
	const first: unknown = input[0];
	if (isRecord(first) && (first.role === "system" || first.role === "developer")) {
		const content = first.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
							.join("")
					: "";
		// Only the adapter's leading system prompt moves. Later developer messages remain ordered input.
		return { instructions: systemPrompt || text || undefined, input: input.slice(1) };
	}
	return { instructions: systemPrompt, input };
}
