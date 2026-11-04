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
	"Query DeepWiki's AI-generated documentation for indexed public GitHub repositories. Inspect a repository's wiki structure, read one page or a whole wiki truncated past ~120k characters, or ask focused questions about one repository or compare up to 10 repositories. Results are indexed public snapshots and may cite sources. Unindexed repositories fail with a repository-not-found error.";

export const DEEPWIKI_PROMPT_SNIPPET =
	"Query AI-generated docs for indexed public GitHub repos: architecture, APIs, implementation patterns";

// Routing only: how to pick and reject `deepwiki`. Per-parameter syntax stays in
// DeepWikiParamsSchema, which the model receives in the same request.
export const DEEPWIKI_PROMPT_GUIDELINES = [
	"Run `deepwiki` action `structure` first for a repo; a repository-not-found error means it is not indexed, so do not retry that repo with `contents` or `question`.",
	"Do not use `deepwiki` for local workspace files, private repos, exact current HEAD, or freshness-sensitive facts (releases, pricing, advisories); use local tools or current primary sources instead.",
];
