export const CODE_TOOL_NAME = "code_search";
export const CODE_TOOL_LABEL = "Code Search";
export const WEB_TOOL_NAME = "web_search";
export const WEB_TOOL_LABEL = "Web Search";

export const EXTENSION_LABEL = "Devin Search";

export const CODE_TOOL_DESCRIPTION =
	"Semantic code discovery for the current local repo, powered by Devin's hosted SWE-grep backend. " +
	"Prefer it when relevant files are unknown and the task needs exploratory, behavioral, architectural, " +
	"or cross-module understanding, especially in large or unfamiliar codebases. Describe the behavior, flow, " +
	"error, or concept to locate (concise English queries match best; see the query parameter). Returns " +
	"candidate paths, line ranges, and grep keywords only — a reading list, not evidence: read or grep the " +
	"results before editing. For known paths, exact symbols, filenames, literals, or existence checks, use " +
	"local find/grep/read directly.";

export const CODE_TOOL_SNIPPET =
	"Semantic discovery of unknown local code by behavior or concept; verify results with read/grep";

export const CODE_TOOL_GUIDELINES = [
	"Prefer `code_search` early for non-trivial local code research when relevant files are unknown: exploration, architecture tracing, bug-flow discovery, feature or refactor planning.",
	"Do not use `code_search` for known filenames, paths, exact symbols, literal strings, or existence checks; use local find/grep/read for those.",
	"Treat `code_search` output as a reading list: read returned ranges before editing; if results are empty or weak, retry once with a narrower behavioral query or fall back to grep.",
	"Use `web_search` for external facts, docs, releases, and errors; it queries the live web through Devin.",
];

export const WEB_TOOL_DESCRIPTION =
	"Search the live web through Devin's hosted search backend. Use it for external facts, library and API " +
	"documentation, error messages, release notes, and any question about the world outside the local repo. " +
	"Returns titles, URLs, and snippets; open the promising URLs when you need full content. For code inside " +
	"the current repository use code_search; for known answers use your own knowledge.";

export const WEB_TOOL_SNIPPET = "Live web search via Devin: external facts, docs, errors, releases";

export const WEB_TOOL_GUIDELINES = [
	"Prefer `web_search` over guessing for freshness-sensitive facts: releases, pricing, breaking changes, CVEs, and current events.",
	"Treat results as pointers: follow up with reads of the most relevant URLs when the snippets are not sufficient.",
	"Do not use `web_search` for questions answerable from the local repository; use code_search, read, or grep for those.",
];

/** The single entry point: sign in with an account, paste a key, or clear the saved key. */
export const CMD_SEARCH = "search";

export const ENV_KEY = "SEARCH_KEY";

/** Windsurf/Devin handshake identity: both backends key their protocol behavior off this app id. */
export const WS_APP = "windsurf";
