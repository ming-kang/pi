/**
 * Fetch the OpenAI-style model catalog from a configured provider endpoint.
 *
 * Auth is resolved by the caller through ModelRuntime.getAuth() so Pi's
 * credential precedence (auth.json > env > models.json) applies. Raw
 * `$VAR` / `!command` placeholders never reach the wire: a failed resolution
 * aborts before this function is called.
 *
 * Entries keep the metadata they declare under common field names: context
 * window, output limit, image input, and reasoning. Anthropic-compatible
 * gateways that reject the Anthropic catalog request get one OpenAI-style
 * retry, and Anthropic catalogs follow their `has_more` pages.
 */

import type { FetchFunction, ModelAuth, ProviderHeaders } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ModelsJsonModel } from "../../core/model-config.ts";
import { readResponseTextBounded } from "../../utils/http-response.ts";
import { formatError, PROBE_LIMITS } from "./constants.ts";

/** A catalog entry: its id plus the metadata it declared, already valid as a models.json model. */
export type ProbeModel = Pick<ModelsJsonModel, "id" | "name" | "contextWindow" | "maxTokens" | "input" | "reasoning">;

export type ProbeResult = { ok: true; models: ProbeModel[]; truncated: boolean } | { ok: false; error: string };

type CatalogPage = { ok: true; json: unknown } | { ok: false; status?: number; error: string };

export async function probeProviderModels(opts: {
	baseUrl: string;
	/** Resolved auth from ModelRuntime.getAuth(). Undefined = anonymous public catalog. */
	auth?: ModelAuth;
	/** Effective provider api; selects the protocol's auth header scheme. */
	api?: string;
	fetch?: FetchFunction;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ProbeResult> {
	let baseUrl: URL;
	try {
		baseUrl = new URL(opts.baseUrl);
	} catch {
		return { ok: false, error: "Base URL is not a valid URL." };
	}
	if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
		return { ok: false, error: `Unsupported protocol: ${baseUrl.protocol}` };
	}
	if (baseUrl.username || baseUrl.password || baseUrl.hash) {
		return { ok: false, error: "Base URL must not contain credentials or a fragment." };
	}
	if (opts.signal?.aborted) return { ok: false, error: "Cancelled." };

	const controller = new AbortController();
	const timeoutMs = opts.timeoutMs ?? PROBE_LIMITS.timeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onOuterAbort = () => controller.abort();
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

	const doFetch = opts.fetch ?? globalThis.fetch;
	const getPage = async (url: URL, headers: Headers): Promise<CatalogPage> => {
		const response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
		if (!response.ok) {
			const body = await readResponseTextBounded(response, {
				maxBytes: PROBE_LIMITS.maxErrorBytes,
				signal: controller.signal,
			});
			return {
				ok: false,
				status: response.status,
				error: `HTTP ${response.status}${body ? `: ${safeErrorText(body, opts.auth).slice(0, PROBE_LIMITS.maxErrorChars)}` : ""}`,
			};
		}
		const text = await readResponseTextBounded(response, {
			maxBytes: PROBE_LIMITS.maxBodyBytes,
			overflowMessage: `Response exceeds ${PROBE_LIMITS.maxBodyBytes} bytes.`,
			signal: controller.signal,
		});
		try {
			return { ok: true, json: JSON.parse(text) };
		} catch {
			return { ok: false, error: "Model catalog response is not JSON." };
		}
	};

	try {
		let url = modelCatalogUrl(baseUrl, opts.api);
		let headers = buildHeaders(opts.auth, opts.api);
		let page = await getPage(url, headers);
		const retry = page.ok
			? undefined
			: openAIStyleRetry(baseUrl, opts.auth, opts.api, { url, headers, status: page.status });
		if (!page.ok && retry) {
			const retried = await getPage(retry.url, retry.headers);
			if (!retried.ok) {
				return {
					ok: false,
					error: safeErrorText(
						`${url.href} → HTTP ${page.status}; OpenAI-style retry ${retry.url.href} → ${retried.error}`,
						opts.auth,
					),
				};
			}
			({ url, headers } = retry);
			page = retried;
		}
		if (!page.ok) return { ok: false, error: page.error };
		const models = parseCatalogModels(page.json);
		if (models === null) {
			return {
				ok: false,
				error: "JSON has no supported OpenAI-style data[] or models[] catalog with model ids. Add models manually if this endpoint uses another catalog format.",
			};
		}
		// Anthropic lists 20 models per page unless asked for more; follow its cursor.
		let json = page.json;
		for (
			let pages = 1;
			opts.api === "anthropic-messages" && pages < PROBE_LIMITS.maxPages && models.length < PROBE_LIMITS.maxModels;
			pages++
		) {
			const cursor = nextPageCursor(json);
			if (!cursor) break;
			const nextUrl = new URL(url.href);
			nextUrl.searchParams.set("after_id", cursor);
			nextUrl.searchParams.set("limit", "1000");
			const next = await getPage(nextUrl, headers);
			const more = next.ok ? parseCatalogModels(next.json) : null;
			// A failed page keeps what is already listed; the catalog stays marked partial.
			if (!next.ok || !more) break;
			models.push(...more);
			// A server ignoring the cursor would repeat this page forever.
			if (nextPageCursor(next.json) === cursor) break;
			json = next.json;
		}
		const sorted = dedupeSort(models);
		const truncated = sorted.length > PROBE_LIMITS.maxModels || declaresMorePages(json);
		return { ok: true, models: sorted.slice(0, PROBE_LIMITS.maxModels), truncated };
	} catch (error) {
		if (controller.signal.aborted) {
			return { ok: false, error: opts.signal?.aborted ? "Cancelled." : `Timed out after ${timeoutMs}ms.` };
		}
		return { ok: false, error: safeErrorText(formatError(error), opts.auth) };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/** Append a path segment, keeping the query string and avoiding duplicate slashes or a doubled /v1. */
export function modelCatalogUrl(base: URL, api?: string): URL {
	const url = new URL(base.href);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = api === "anthropic-messages" && !path.endsWith("/v1") ? `${path}/v1/models` : `${path}/models`;
	return url;
}

/**
 * Anthropic-compatible gateways often serve their catalog OpenAI-style only:
 * StepFun's /step_plan/v1/models rejects x-api-key but accepts Bearer, and
 * DeepSeek's /anthropic has no catalog while its root /v1/models does. One
 * retry with Bearer auth and a trailing /anthropic segment removed covers
 * both, stays on the same origin, and leaves configured Authorization alone.
 */
function openAIStyleRetry(
	base: URL,
	auth: ModelAuth | undefined,
	api: string | undefined,
	first: { url: URL; headers: Headers; status?: number },
): { url: URL; headers: Headers } | undefined {
	if (api !== "anthropic-messages" || ![401, 403, 404].includes(first.status ?? 0)) return undefined;
	if (Object.keys(auth?.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) return undefined;
	const root = new URL(base.href);
	root.pathname = root.pathname.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
	const url = modelCatalogUrl(root, api);
	const headers = buildHeaders(auth, undefined);
	const unchanged = url.href === first.url.href && headers.get("authorization") === first.headers.get("authorization");
	return unchanged ? undefined : { url, headers };
}

function safeErrorText(text: string, auth: ModelAuth | undefined): string {
	for (const value of [auth?.apiKey, ...Object.values(auth?.headers ?? {})]) {
		if (typeof value !== "string" || !value) continue;
		text = text.replaceAll(value, "[redacted]");
		const token = value.replace(/^Bearer\s+/i, "");
		if (token !== value && token) text = text.replaceAll(token, "[redacted]");
	}
	return stripTerminalSequences(text);
}

function buildHeaders(auth: ModelAuth | undefined, api: string | undefined): Headers {
	const headers = new Headers();
	headers.set("accept", "application/json");
	const configured: ProviderHeaders = auth?.headers ?? {};
	if (api === "anthropic-messages") headers.set("anthropic-version", "2023-06-01");
	let hasAuthorization = false;
	for (const [key, value] of Object.entries(configured)) {
		// null explicitly removes a header; it also suppresses the default auth header.
		if (key.toLowerCase() === "authorization") hasAuthorization = true;
		if (typeof value === "string") headers.set(key, value);
		else if (value === null) headers.delete(key);
	}
	headers.set("accept", "application/json");
	if (!auth?.apiKey || hasAuthorization) return headers;
	const lower = (name: string) => Object.keys(configured).some((key) => key.toLowerCase() === name);
	if (api === "anthropic-messages") {
		// Mirror pi-ai: OAuth tokens use Bearer; plain keys use x-api-key + version.
		if (auth.apiKey.includes("sk-ant-oat")) {
			headers.set("authorization", `Bearer ${auth.apiKey}`);
		} else {
			if (!lower("x-api-key")) headers.set("x-api-key", auth.apiKey);
			if (!lower("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
		}
		return headers;
	}
	if (api === "google-generative-ai" || api === "google-vertex") {
		if (!lower("x-goog-api-key")) headers.set("x-goog-api-key", auth.apiKey);
		return headers;
	}
	headers.set("authorization", `Bearer ${auth.apiKey}`);
	return headers;
}

function declaresMorePages(json: unknown): boolean {
	return typeof json === "object" && json !== null && "has_more" in json && json.has_more === true;
}

function nextPageCursor(json: unknown): string | undefined {
	if (!declaresMorePages(json)) return undefined;
	const lastId = (json as { last_id?: unknown }).last_id;
	return typeof lastId === "string" && lastId ? lastId : undefined;
}

// Catalogs name the same metadata differently; each list holds the field
// paths seen in real /models responses.
const CONTEXT_WINDOW_FIELDS = [
	"context_window",
	"context_window.tokens",
	"context_length",
	"top_provider.context_length",
	"max_input_tokens",
	"max_context_length",
	"max_model_len",
	"context_size",
	"metadata.context_length",
];
const MAX_TOKENS_FIELDS = [
	"max_output_tokens",
	"max_completion_tokens",
	"top_provider.max_completion_tokens",
	"max_tokens",
	"max_output_length",
];
const INPUT_MODALITY_FIELDS = ["input_modalities", "architecture.input_modalities", "modalities.input"];
const IMAGE_FLAG_FIELDS = [
	"supports_vision",
	"enable_vision_input",
	"capabilities.vision",
	"capabilities.image_input.supported",
];
const REASONING_FLAG_FIELDS = [
	"reasoning",
	"supports_reasoning",
	"enable_reason",
	"capabilities.reasoning",
	"capabilities.thinking.supported",
];
const REASONING_LEVEL_FIELDS = ["effort.supported_levels", "reasoning_effort_support_list"];
/** Capability lists that can name `reasoning` or `vision`. */
const CAPABILITY_LIST_FIELDS = ["supported_parameters", "tags", "features", "supported_features", "metadata.tags"];

function fieldAt(record: Record<string, unknown>, path: string): unknown {
	let value: unknown = record;
	for (const key of path.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function listAt(record: Record<string, unknown>, path: string): string[] {
	const value = fieldAt(record, path);
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase());
}

/**
 * Only positive integers count (Anthropic documents 0 as a placeholder). When
 * fields disagree the smallest wins: overstating a limit overflows requests,
 * understating it only compacts earlier.
 */
function declaredLimit(record: Record<string, unknown>, paths: readonly string[]): number | undefined {
	let limit: number | undefined;
	for (const path of paths) {
		const value = fieldAt(record, path);
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
			limit = Math.min(limit ?? value, value);
	}
	return limit;
}

function declaresImageInput(record: Record<string, unknown>): boolean {
	return (
		INPUT_MODALITY_FIELDS.some((path) => listAt(record, path).includes("image")) ||
		IMAGE_FLAG_FIELDS.some((path) => fieldAt(record, path) === true) ||
		CAPABILITY_LIST_FIELDS.some((path) => listAt(record, path).includes("vision"))
	);
}

function declaresReasoning(record: Record<string, unknown>): boolean {
	return (
		REASONING_FLAG_FIELDS.some((path) => fieldAt(record, path) === true) ||
		REASONING_LEVEL_FIELDS.some((path) => listAt(record, path).length > 0) ||
		CAPABILITY_LIST_FIELDS.some((path) => listAt(record, path).includes("reasoning"))
	);
}

function parseCatalogModels(json: unknown): ProbeModel[] | null {
	if (!json || typeof json !== "object") return null;
	const payload = json as { models?: unknown; data?: unknown };
	const data = Array.isArray(json) ? json : Array.isArray(payload.models) ? payload.models : payload.data;
	if (!Array.isArray(data)) return null;
	const models: ProbeModel[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const id =
			(typeof record.id === "string" ? record.id.trim() : "") ||
			(typeof record.slug === "string" ? record.slug.trim() : "");
		if (!id) continue;
		// OpenAI uses `name`; Anthropic's /v1/models uses `display_name`.
		const displayName = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
		const anthropicName =
			typeof record.display_name === "string" && record.display_name.trim()
				? record.display_name.trim()
				: typeof record.displayName === "string"
					? record.displayName.trim()
					: undefined;
		const name = (displayName ?? anthropicName) !== id ? (displayName ?? anthropicName) : undefined;
		const model: ProbeModel = name ? { id, name } : { id };
		const contextWindow = declaredLimit(record, CONTEXT_WINDOW_FIELDS);
		if (contextWindow) model.contextWindow = contextWindow;
		const maxTokens = declaredLimit(record, MAX_TOKENS_FIELDS);
		if (maxTokens) model.maxTokens = maxTokens;
		// models.json represents only text and image input.
		if (declaresImageInput(record)) model.input = ["text", "image"];
		if (declaresReasoning(record)) model.reasoning = true;
		models.push(model);
	}
	return data.length > 0 && models.length === 0 ? null : models;
}

function dedupeSort(models: ProbeModel[]): ProbeModel[] {
	const map = new Map<string, ProbeModel>();
	for (const model of models) {
		if (!map.has(model.id)) map.set(model.id, model);
	}
	return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
