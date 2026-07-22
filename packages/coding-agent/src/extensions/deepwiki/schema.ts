import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { normalizePageRef } from "./contents.ts";

export const DEEPWIKI_ACTIONS = ["structure", "contents", "question"] as const;
const MAX_QUESTION_REPOS = 10;

const DeepWikiActionSchema = StringEnum(DEEPWIKI_ACTIONS, {
	description:
		"DeepWiki operation: structure lists generated wiki pages for one repo, contents reads the full generated wiki for one repo, and question answers focused repo/reference/comparison questions across up to 10 repos.",
});

export const DeepWikiParamsSchema = Type.Object({
	action: DeepWikiActionSchema,
	repoName: Type.Union([
		Type.String({
			minLength: 1,
			description:
				'One public GitHub repo as "owner/repo" (preferred), or a GitHub/DeepWiki URL. Required for structure and contents; for question with a single repo use this string form — not a one-element array.',
		}),
		Type.Array(
			Type.String({
				minLength: 1,
				description: 'Public GitHub repo in "owner/repo" format.',
			}),
			{
				minItems: 1,
				maxItems: MAX_QUESTION_REPOS,
				description:
					"Only for action question when comparing 2-10 repos. Each entry is owner/repo. For one repo use a string repoName instead.",
			},
		),
	]),
	question: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Required for action question. Ask a focused question about architecture, APIs, implementation patterns, extension points, onboarding, or cross-repo comparison.",
		}),
	),
	page: Type.Optional(
		Type.Union([Type.String({ minLength: 1 }), Type.Number()], {
			description:
				'Only for action contents: one page by 1-based index or by title from structure (e.g. "Extension System") — titles do not include outline numbers like "4.4". Run structure first if unsure. Prefer page reads over omitting page.',
		}),
	),
});

export type DeepWikiAction = (typeof DEEPWIKI_ACTIONS)[number];
export type DeepWikiParams = Static<typeof DeepWikiParamsSchema>;

const ACTION_ALIASES: Record<string, DeepWikiAction> = {
	ask: "question",
	ask_question: "question",
	contents: "contents",
	content: "contents",
	full: "contents",
	map: "structure",
	pages: "structure",
	question: "question",
	query: "question",
	read_wiki_contents: "contents",
	read_wiki_structure: "structure",
	structure: "structure",
	topics: "structure",
	wiki: "contents",
};

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function readPageRef(record: Record<string, unknown>): string | number | undefined {
	for (const key of ["page", "pageName", "pageTitle"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) return normalizePageRef(value.trim());
	}
	return undefined;
}

function coerceRepoNameInput(value: unknown): unknown {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("[")) return value;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* keep original string */
	}
	return value;
}

function normalizeAction(
	action: unknown,
	question: string | undefined,
	page: string | number | undefined,
): DeepWikiAction {
	if (typeof action === "string") {
		const key = action
			.trim()
			.toLowerCase()
			.replace(/[\s-]+/g, "_");
		if (!key) return inferAction(question, page);
		const normalized = ACTION_ALIASES[key];
		if (normalized) return normalized;
		throw new Error(`unsupported deepwiki action: ${action}`);
	}
	if (action !== undefined && action !== null) {
		throw new Error("deepwiki action must be a string");
	}
	return inferAction(question, page);
}

function inferAction(question: string | undefined, page: string | number | undefined): DeepWikiAction {
	if (question) return "question";
	if (page !== undefined) return "contents";
	return "structure";
}

export function normalizeRepoName(value: unknown): string {
	if (typeof value !== "string") throw new Error("repoName is required");

	const input = value.trim().replace(/^\/+|\/+$/g, "");
	if (!input) throw new Error("repoName is required");

	let owner: string | undefined;
	let repo: string | undefined;

	const sshMatch = input.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
	if (sshMatch) {
		owner = sshMatch[1];
		repo = sshMatch[2];
	} else if (/^(?:https?:\/\/)?(?:www\.)?(?:github\.com|deepwiki\.com)\//i.test(input)) {
		const urlInput = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
		try {
			const url = new URL(urlInput);
			const [urlOwner, urlRepo] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
			owner = urlOwner;
			repo = urlRepo?.replace(/\.git$/i, "");
		} catch {
			throw new Error('repoName must use "owner/repo" format');
		}
	} else {
		const parts = input.replace(/\.git$/i, "").split("/");
		if (parts.length === 2) {
			[owner, repo] = parts;
		}
	}

	if (!owner || !repo || !GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo)) {
		throw new Error('repoName must use a public GitHub "owner/repo" identifier');
	}
	return `${owner}/${repo}`;
}

function normalizeRepoNames(value: unknown): string[] {
	value = coerceRepoNameInput(value);
	const values =
		typeof value === "string" && value.includes(",")
			? value
					.split(",")
					.map((repo) => repo.trim())
					.filter(Boolean)
			: Array.isArray(value)
				? value
				: [value];
	const repos = values.map((item) => normalizeRepoName(item));
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const repo of repos) {
		const key = repo.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(repo);
	}
	if (unique.length > MAX_QUESTION_REPOS) {
		throw new Error(`question action supports at most ${MAX_QUESTION_REPOS} repositories`);
	}
	return unique;
}

export function normalizeDeepWikiParams(input: unknown): DeepWikiParams {
	if (!input || typeof input !== "object") {
		throw new Error("deepwiki arguments must be an object");
	}

	const record = input as Record<string, unknown>;
	const question = readString(record, ["question", "query", "prompt"]);
	const page = readPageRef(record);
	const action = normalizeAction(record.action, question, page);
	const rawRepoName =
		record.repoName ??
		record.repo ??
		record.repos ??
		record.repository ??
		record.repositories ??
		record.githubRepo ??
		record.githubRepos;
	const repoNames = normalizeRepoNames(rawRepoName);

	if (action === "question") {
		if (!question) throw new Error("question is required when action is question");
		return {
			action,
			repoName: repoNames.length > 1 ? repoNames : repoNames[0],
			question,
		};
	}

	if (repoNames.length !== 1) {
		throw new Error(`${action} action requires exactly one repository`);
	}

	// page is meaningful only for contents; structure/question ignore it.
	return {
		action,
		repoName: repoNames[0],
		...(action === "contents" && page !== undefined ? { page } : {}),
	};
}
