/**
 * Fetch the OpenAI-style model catalog from a configured provider endpoint.
 *
 * Auth is resolved by the caller through ModelRuntime.getAuth() so Pi's
 * credential precedence (auth.json > env > models.json) applies. Raw
 * `$VAR` / `!command` placeholders never reach the wire: a failed resolution
 * aborts before this function is called.
 */

import type { FetchFunction, ModelAuth, ProviderHeaders } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { readResponseTextBounded } from "../../utils/http-response.ts";
import { formatError, PROBE_LIMITS } from "./constants.ts";

export interface ProbeModel {
	id: string;
	name?: string;
}

export type ProbeResult = { ok: true; models: ProbeModel[]; truncated: boolean } | { ok: false; error: string };

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

	try {
		const url = modelCatalogUrl(baseUrl, opts.api);
		const headers = buildHeaders(opts.auth, opts.api);
		const doFetch = opts.fetch ?? globalThis.fetch;
		const response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
		if (!response.ok) {
			const body = await readResponseTextBounded(response, {
				maxBytes: PROBE_LIMITS.maxErrorBytes,
				signal: controller.signal,
			});
			return {
				ok: false,
				error: `HTTP ${response.status}${body ? `: ${safeErrorText(body, opts.auth).slice(0, PROBE_LIMITS.maxErrorChars)}` : ""}`,
			};
		}
		const text = await readResponseTextBounded(response, {
			maxBytes: PROBE_LIMITS.maxBodyBytes,
			overflowMessage: `Response exceeds ${PROBE_LIMITS.maxBodyBytes} bytes.`,
			signal: controller.signal,
		});
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return { ok: false, error: "Model catalog response is not JSON." };
		}
		const models = parseCatalogModels(json);
		if (models === null) {
			return {
				ok: false,
				error: "JSON has no supported OpenAI-style data[] or models[] catalog with model ids. Add models manually if this endpoint uses another catalog format.",
			};
		}
		const sorted = dedupeSort(models);
		const morePages = typeof json === "object" && json !== null && "has_more" in json && json.has_more === true;
		const truncated = sorted.length > PROBE_LIMITS.maxModels || morePages;
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
		models.push(name ? { id, name } : { id });
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
