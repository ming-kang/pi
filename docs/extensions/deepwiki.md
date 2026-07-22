# DeepWiki

`deepwiki` is a Pi-native tool for querying DeepWiki's generated documentation for GitHub repositories.

It is intentionally not a general MCP bridge. The extension exposes one dedicated tool with three fixed actions:

| Action | Behavior |
|---|---|
| `structure` | List the generated wiki topics for a repository. |
| `contents` | Read the generated wiki — one page via `page` (recommended), or everything when `page` is omitted (truncated past ~120k chars). |
| `question` | Ask a focused question about a repository. |

## Tool Parameters

- `action`: `structure`, `contents`, or `question`
- `repoName`: one `owner/repo` string for `structure` and `contents`; for `question`, one repo as a string, or 2–10 repos as an array (comma-separated string also accepted)
- `question`: required only for `action: "question"`
- `page`: optional, only for `action: "contents"` — 1-based index or page title from `structure` (plain titles such as `Extension System`, not numbered outline lines like `4.4 …`). Leading outline numbers on titles are stripped when matching. Unknown `page` fails with available titles listed.

`repoName` is normalized before validation (`owner/repo`, GitHub/DeepWiki URLs, JSON-array strings for multi-repo mistakes). `pageName`/`pageTitle` are accepted as `page` aliases. If `action` is omitted, defaults to `question` when a question is present, `contents` when `page` is present, else `structure`. Repositories not indexed on DeepWiki return repository-not-found errors — run `structure` first to detect that.

## How it works

DeepWiki's public MCP endpoint exposes exactly three operations: list a wiki's page titles, return the whole generated wiki as one document, and answer a question. There is no per-page fetch upstream — `page` is implemented by this extension: it fetches the full wiki (or reuses the 10-minute cache) and slices out the requested page locally. The first `contents` call for a repo pays the network cost; subsequent page reads within the cache window are instant and free.

## Usage Strategy

Recommended flow for studying a repo:

1. `structure` — get the page outline.
2. `contents` + `page` — read the specific pages you need, one at a time.
3. Avoid `contents` without `page` (the full wiki) unless the wiki is genuinely small; oversized output is truncated at ~120k chars.
4. `question` — when the wiki pages don't cover what you need, or directly for a quick answer without reading.

Use DeepWiki when generated docs for public repositories are useful context:

- Understanding an unfamiliar public repo's architecture, module layout, APIs, data flow, or extension points.
- Researching reference implementations while designing or building a new feature or project.
- Asking a focused question about how a public repo implements something.
- Comparing patterns or extension surfaces across multiple public repos with `question` and a repo array.
- Pulling a broad topic map with `structure` before deciding which part of a repo matters.

The prompt is model-facing: when these conditions apply, the model should call the tool itself instead of telling the user to open DeepWiki manually.

Avoid DeepWiki when the authoritative source is local or time-sensitive:

- Local workspace files, private code, uncommitted changes, or exact current checkout state.
- Latest releases, pricing, security advisories, schedules, or facts that need current primary-source verification.
- Package names without a known GitHub repo; resolve the repo first instead of guessing.

## Notes

- DeepWiki currently exposes this data through its public MCP HTTP endpoint; this extension calls only the three DeepWiki operations above.
- DeepWiki may return generated explanations with source-file citations and "related pages" links. The TUI uses a local renderer (`render.ts`) for a one-line collapsed summary and Markdown when expanded; Pi's default fallback would dump the full (often large) `content` text.
- `contents` responses are truncated at a ~120k-character budget on `# Page:` boundaries (whole pages kept in order; at least the first page survives, cut mid-page if it alone exceeds the budget). A trailing notice reports shown/total pages, the full length, up to 20 omitted page titles, and points at `page` reads and `action: "question"` for the rest. Details carry `shownPages` / `truncatedChars` when this happens; `outputLength` always reflects the full untruncated response. Single-page reads set `requestedPage` / `pageIndex` instead and share the same budget.
- A repository may not be indexed. DeepWiki can return that as normal text, so the extension treats repository-not-found messages as tool errors.
- Successful responses are cached in-process for 10 minutes, keyed by action, repo, and question. Failed, aborted, and timed-out requests are not cached. The cache stores the full response; `contents` truncation is recomputed per call, so cached and fresh calls return identical text.
- Network requests time out after 45 seconds and surface as Pi tool errors.
- Use local Pi tools (`read`, `grep`, `find`, `ls`) for workspace state. DeepWiki answers describe repository snapshots indexed by DeepWiki, not local uncommitted files.
