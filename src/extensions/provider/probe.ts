/**
 * Fetch the OpenAI-style model catalog from a configured provider endpoint.
 *
 * Auth is resolved by the caller through ModelRuntime.getAuth() so Pi's
 * credential precedence (auth.json > env > models.json) applies. Raw
 * `$VAR` / `!command` placeholders never reach the wire: a failed resolution
 * aborts before this function is called.
 */

import type { FetchFunction, ModelAuth, ProviderHeaders } from "@earendil-works/pi-ai";
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
		const url = appendPath(baseUrl, "models");
		const headers = buildHeaders(opts.auth);
		const doFetch = opts.fetch ?? globalThis.fetch;
		const response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
		if (!response.ok) {
			const body = await readResponseTextBounded(response, {
				maxBytes: PROBE_LIMITS.maxErrorBytes,
				signal: controller.signal,
			});
			return {
				ok: false,
				error: `HTTP ${response.status}${body ? `: ${body.slice(0, PROBE_LIMITS.maxErrorChars)}` : ""}`,
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
		const models = parseOpenAIModels(json);
		if (models === null) {
			return {
				ok: false,
				error: "JSON has no OpenAI-style `data` array of model ids. This endpoint may not expose an OpenAI-compatible catalog; add models manually instead.",
			};
		}
		const sorted = dedupeSort(models);
		const truncated = sorted.length > PROBE_LIMITS.maxModels;
		return { ok: true, models: sorted.slice(0, PROBE_LIMITS.maxModels), truncated };
	} catch (error) {
		if (controller.signal.aborted) {
			return { ok: false, error: opts.signal?.aborted ? "Cancelled." : `Timed out after ${timeoutMs}ms.` };
		}
		return { ok: false, error: formatError(error) };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/** Append a path segment, keeping the query string and avoiding duplicate slashes or a doubled /v1. */
function appendPath(base: URL, segment: string): URL {
	const url = new URL(base.href);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = `${path}/${segment}`;
	return url;
}

function buildHeaders(auth: ModelAuth | undefined): Headers {
	const headers = new Headers();
	headers.set("accept", "application/json");
	const configured: ProviderHeaders = auth?.headers ?? {};
	let hasAuthorization = false;
	for (const [key, value] of Object.entries(configured)) {
		// null explicitly removes a header; it also suppresses the default Bearer.
		if (key.toLowerCase() === "authorization") hasAuthorization = true;
		if (typeof value === "string") headers.set(key, value);
	}
	if (auth?.apiKey && !hasAuthorization) headers.set("authorization", `Bearer ${auth.apiKey}`);
	return headers;
}

function parseOpenAIModels(json: unknown): ProbeModel[] | null {
	if (!json || typeof json !== "object") return null;
	const data = (json as { data?: unknown }).data;
	if (!Array.isArray(data)) return null;
	const models: ProbeModel[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.trim() : "";
		if (!id) continue;
		const name =
			typeof record.name === "string" && record.name.trim() && record.name.trim() !== id
				? record.name.trim()
				: undefined;
		models.push(name ? { id, name } : { id });
	}
	return models;
}

function dedupeSort(models: ProbeModel[]): ProbeModel[] {
	const map = new Map<string, ProbeModel>();
	for (const model of models) {
		if (!map.has(model.id)) map.set(model.id, model);
	}
	return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
