/**
 * schema.ts — TypeBox parameter schema and argument normalizer for web_search.
 */

import { type Static, Type } from "typebox";

export const WebSearchParamsSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "The search query. Aim for 3-5 keywords for best results.",
	}),
	allowed_domains: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Optional list of domains to include in search results (e.g. ['github.com', 'react.dev']). Cannot be used alongside blocked_domains.",
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Optional list of domains to exclude from search results. Cannot be used alongside allowed_domains.",
		}),
	),
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

	const parseDomainArray = (val: unknown): string[] | undefined => {
		if (Array.isArray(val)) {
			const list = val.map((x) => String(x).trim()).filter((x) => x.length > 0);
			return list.length > 0 ? list : undefined;
		}
		if (typeof val === "string" && val.trim()) {
			return [val.trim()];
		}
		return undefined;
	};

	const allowedDomains = parseDomainArray(record.allowed_domains ?? record.allowedDomains);
	const blockedDomains = parseDomainArray(record.blocked_domains ?? record.blockedDomains);

	return {
		query,
		...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
		...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
	};
}
