/** Fetch a bounded OpenAI or Codex model catalog from a relay baseUrl. */

import type { FetchFunction, ProviderHeaders } from "@earendil-works/pi-ai";
import { readResponseTextBounded } from "../../utils/http-response.ts";
import { DEFAULTS, formatError, THINKING_LEVELS } from "./constants.ts";
import { buildCodexHeaders, CODEX_VERSION, createCodexFetch } from "./identity.ts";
import type { RelayModelConfig, ThinkingLevelMap } from "./types.ts";

export interface ProbeModel extends Pick<RelayModelConfig, "id" | "name"> {
	/** Merge into local defaults, then cap default maxTokens to the resulting contextWindow. */
	metadata?: Partial<Omit<RelayModelConfig, "id" | "name">>;
}

export type ProbeResult = { ok: true; models: ProbeModel[]; truncated: boolean } | { ok: false; error: string };

export async function probeRelayModels(opts: {
	baseUrl: string;
	apiKey?: string;
	/** Resolved values only: config/env/command resolution belongs to the caller. */
	headers?: ProviderHeaders;
	catalog?: "openai" | "codex";
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
	const timeoutMs = opts.timeoutMs ?? DEFAULTS.probeTimeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onOuterAbort = () => controller.abort();
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const url = appendPath(baseUrl, "models");
		// Codex models-manager uses Cargo major.minor.patch, dropping prerelease only.
		if (opts.catalog === "codex") {
			// Keep unrelated query bytes intact (including %20, ~ and repeated parameters).
			const query = url.search.slice(1).split("&").filter(Boolean);
			const version = `client_version=${CODEX_VERSION}`;
			const existing = query.findIndex((part) => new URLSearchParams(part).has("client_version"));
			if (existing < 0) query.push(version);
			else {
				query[existing] = version;
				for (let index = query.length - 1; index > existing; index--) {
					if (new URLSearchParams(query[index]).has("client_version")) query.splice(index, 1);
				}
			}
			url.search = query.join("&");
		}
		const headers = new Headers();
		for (const [key, value] of Object.entries(
			buildCodexHeaders({
				"content-type": null,
				...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
				...opts.headers,
			}),
		)) {
			if (typeof value === "string") headers.set(key, value);
		}
		headers.set("accept", "application/json");

		const response = await createCodexFetch(opts.fetch)(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await readResponseTextBounded(response, {
				maxBytes: 4_096,
				signal: controller.signal,
			});
			return {
				ok: false,
				error: `HTTP ${response.status}${body ? `: ${body.slice(0, 400)}` : ""}`,
			};
		}
		const text = await readResponseTextBounded(response, {
			maxBytes: DEFAULTS.probeBodyBytes,
			overflowMessage: `Response exceeds ${DEFAULTS.probeBodyBytes} bytes.`,
			signal: controller.signal,
		});
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return { ok: false, error: "Model catalog response is not JSON." };
		}
		const models = opts.catalog === "codex" ? parseCodexModels(json) : parseOpenAIModels(json);
		if (models === null) {
			return {
				ok: false,
				error:
					opts.catalog === "codex"
						? "JSON has no Codex-style `models` array of model slugs. Check the base URL and catalog setting."
						: "JSON has no OpenAI-style `data` array of model ids. Check the base URL and catalog setting.",
			};
		}
		const sorted = dedupeSort(models);
		const truncated = sorted.length > DEFAULTS.probeMaxModels;
		return {
			ok: true,
			models: sorted.slice(0, DEFAULTS.probeMaxModels),
			truncated,
		};
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

function appendPath(base: URL, segment: string): URL {
	const url = new URL(base.href);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = `${path}/${segment}`;
	return url;
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

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseCodexModels(json: unknown): ProbeModel[] | null {
	if (!json || typeof json !== "object") return null;
	const data = (json as { models?: unknown }).models;
	if (!Array.isArray(data)) return null;
	const models: ProbeModel[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const id = typeof record.slug === "string" ? record.slug.trim() : "";
		if (!id) continue;
		const model: ProbeModel = { id };
		if (typeof record.display_name === "string" && record.display_name.trim() && record.display_name.trim() !== id)
			model.name = record.display_name.trim();
		const metadata: NonNullable<ProbeModel["metadata"]> = {};
		const context = positiveInteger(record.context_window);
		const maxContext = positiveInteger(record.max_context_window);
		if (context !== undefined) metadata.contextWindow = Math.min(context, maxContext ?? context);
		// max_context_window is NOT a max output token count. Never infer maxTokens from it.
		if (Array.isArray(record.supported_reasoning_levels)) {
			const efforts = new Set(
				record.supported_reasoning_levels.flatMap((entry: unknown) => {
					const effort =
						typeof entry === "string"
							? entry
							: entry && typeof entry === "object"
								? (entry as { effort?: unknown }).effort
								: undefined;
					return typeof effort === "string" ? [effort] : [];
				}),
			);
			const map: ThinkingLevelMap = {};
			for (const level of THINKING_LEVELS) {
				const effort = level === "off" ? "none" : level;
				map[level] = efforts.has(effort) ? effort : null;
			}
			metadata.thinkingLevelMap = map;
			metadata.reasoning = THINKING_LEVELS.some((level) => level !== "off" && map[level] !== null);
		}
		const codex: NonNullable<RelayModelConfig["codex"]> = {};
		if (record.supports_reasoning_summary_parameter === false) codex.reasoningSummary = null;
		else if (record.supports_reasoning_summary_parameter === true) {
			const summary = record.default_reasoning_summary;
			if (summary === "auto" || summary === "concise" || summary === "detailed") codex.reasoningSummary = summary;
			else if (summary === "none") codex.reasoningSummary = null;
		}
		if (record.support_verbosity === false) codex.verbosity = null;
		else if (record.support_verbosity === true) {
			const verbosity = record.default_verbosity;
			if (verbosity === "low" || verbosity === "medium" || verbosity === "high") codex.verbosity = verbosity;
		}
		if (Object.keys(codex).length) metadata.codex = codex;
		if (Array.isArray(record.input_modalities) && record.input_modalities.includes("text")) {
			metadata.input = record.input_modalities.includes("image") ? ["text", "image"] : ["text"];
		}
		if (Object.keys(metadata).length) model.metadata = metadata;
		models.push(model);
	}
	return models;
}
