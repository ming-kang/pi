/**
 * constants.ts — deepwiki tool identity + prompt copy.
 *
 * Name/label/description/promptSnippet/promptGuidelines live here so
 * `index.ts` only assembles the tool. Prompt copy is the model-facing
 * contract; keep it stable.
 */

export const DEEPWIKI_TOOL_NAME = "deepwiki";
export const DEEPWIKI_LABEL = "DeepWiki";

export const DEEPWIKI_DESCRIPTION =
	"Query DeepWiki's AI-generated documentation for indexed public GitHub repositories. Recommended flow: structure lists the wiki's pages; contents with page (title or 1-based index) reads one page — read pages selectively rather than pulling the whole wiki (omitting page returns everything, truncated past ~120k chars); question answers a focused query (up to 10 repos for comparisons) — reach for it when the wiki pages don't cover what you need, or on its own for a quick answer without reading. Use it for architecture, module layout, APIs, extension points, and implementation patterns when designing or building. Results describe indexed public snapshots and may cite sources; they are not local workspace state, private code, or guaranteed-fresh facts.";

export const DEEPWIKI_PROMPT_SNIPPET =
	"Query AI-generated docs for public GitHub repos: architecture, APIs, implementation patterns, cross-repo comparisons";

export const DEEPWIKI_PROMPT_GUIDELINES = [
	"Use `deepwiki` on public GitHub repos only: run `structure` first for that owner/repo. If structure fails with repository not found, the wiki is not indexed on DeepWiki — do not call contents or question for that repo; pick another repo (e.g. upstream `badlogic/pi-mono` for pi-mono docs).",
	"After structure, use `contents` with `page` set to a 1-based index or an exact page title from the structure list (titles are plain names like `Extension System`, not numbered outline lines like `4.4 Extension System`). Avoid `contents` without `page` unless the wiki is small.",
	"Use `deepwiki` action `question` for a focused answer without reading pages, or when structure/contents do not cover the topic. Single repo: `repoName` as a string. Compare 2-10 repos: `repoName` as an array of owner/repo strings (or comma-separated string).",
	"Do not use `deepwiki` for local workspace files, private repos, exact current HEAD, or freshness-sensitive facts (releases, pricing, advisories); use local tools or current primary sources instead.",
];
