/**
 * schema.ts — TypeBox parameter schema and argument normalizer for web_search.
 */

import { type Static, Type } from "typebox";
import { MAX_QUERY_LENGTH } from "./results.ts";

export const WebSearchParamsSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_LENGTH,
		description: "The search query. Aim for 3-5 keywords; include a year when freshness matters.",
	}),
});

export type WebSearchParams = Static<typeof WebSearchParamsSchema>;

export function normalizeWebSearchParams(raw: unknown): WebSearchParams {
	if (typeof raw === "string") {
		return { query: raw.trim() };
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { query: String(raw ?? "").trim() };
	}

	const record = raw as Record<string, unknown>;

	let query = "";
	if (typeof record.query === "string") {
		query = record.query.trim();
	} else if (typeof record.q === "string") {
		query = record.q.trim();
	} else if (typeof record.search_query === "string") {
		query = record.search_query.trim();
	} else if (typeof record.prompt === "string") {
		query = record.prompt.trim();
	}

	return { query };
}
