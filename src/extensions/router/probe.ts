/** Fetch OpenAI-compatible model catalog from a relay baseUrl. */

import { readResponseTextBounded } from "../../utils/http-response.ts";
import { DEFAULTS, formatError } from "./constants.ts";

export interface ProbeModel {
	id: string;
	name?: string;
}

export type ProbeResult = { ok: true; models: ProbeModel[]; truncated: boolean } | { ok: false; error: string };

export async function probeRelayModels(opts: {
	baseUrl: string;
	apiKey?: string;
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

	if (opts.signal?.aborted) return { ok: false, error: "Cancelled." };
	const controller = new AbortController();
	const timeoutMs = opts.timeoutMs ?? DEFAULTS.probeTimeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onOuterAbort = () => controller.abort();
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const url = appendPath(baseUrl, "models");
		const headers: Record<string, string> = { Accept: "application/json" };
		if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

		const response = await fetch(url, { headers, signal: controller.signal });
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
		const models = parseOpenAIModels(json);
		if (models === null) {
			return { ok: false, error: "JSON has no OpenAI-style `data` array of model ids." };
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
