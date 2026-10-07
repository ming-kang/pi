# Search

Two tools powered by Devin's hosted backends, sharing one Devin key:

| Tool | What it does | Backend |
|---|---|---|
| `code_search` | Semantic code discovery in the local repo | Devin SWE-grep agent loop |
| `web_search` | Live web search | Devin `GetWebSearchResults` JSON |

`code_search` sends your query plus a compact repo map to Devin, which plans a small number of restricted search commands (`rg`/`readfile`/`tree`/`ls`/`glob`) and returns candidate files with line ranges and grep keywords. **This extension executes those commands locally in a strict sandbox**: every path is confined to the current working directory, symlinks are refused, `.gitignore` and default noise directories are honored. What leaves your machine is the repo map of names and paths plus the contents of the files the backend asks to `readfile`. Results are a reading list.

`web_search` sends the query and returns titles, URLs, dates, and snippets. Snippets are truncated and the key is redacted out of all backend responses before parsing.

## Getting a key

Both tools stay hidden from the model until a Devin key exists. Configure it with `/search`, which opens one menu:

- **Sign in with Devin account** — opens `app.devin.ai/auth/cli/continue` in your browser and repeats the URL in the notification in case the browser does not open. Sign in, copy the one-time authorization code, and paste it into the dialog. The code is exchanged at `api.devin.ai/auth/cli/token` and the resulting session token is saved. There is no local HTTP listener and no refresh grant.
- **Sign in with Devin key** — paste a Devin key into the dialog. The dialog warns when the value looks truncated (a `$` eaten by shell or config expansion). Submitting an empty field changes nothing.
- **Clear saved key** — listed only while a key is saved, and only after a confirmation. It deletes the key file and disables both tools.
- **`SEARCH_KEY`** environment variable — for headless and CI runs. Used only when no key file exists; `/search` cannot clear it, so unset the variable instead.

The menu heading names the current state: the masked key and whether it was `saved by account login`, `saved from a pasted key`, or came `from SEARCH_KEY`.

The key is persisted to `~/.pi/agent/search/config.json`.

## Security model

Enforced by this extension, not by the remote backend:

- **Path containment.** Every model-supplied path passes through `PathSandbox` and must resolve inside the current working directory; `..` sequences, other drives, and symlinks are rejected before any filesystem access.
- **Read-only execution.** Only the five structured commands above exist: no shell and no writes. `rg` patterns are matched by the local ripgrep tool, which treats them as regular expressions, and `glob` is matched by a small local matcher that supports `*`, `?`, and `[...]`.
- **Bounded work.** Every command result is capped at 50 lines with 250 characters per line, the repo map is trimmed under its byte budget, and each request runs under a 30 s timeout.

## Parameters (code_search)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Natural-language description of the behavior, flow, or concept to locate. English matches best; keep identifiers and error text verbatim |
| `project_path` | string | cwd | Subtree to search; must resolve inside cwd. Narrow it for monorepos |
| `tree_depth` | int 1–4 | 2 | Skeleton depth of the repo map. The map is trimmed to its byte budget, so a large repo falls back on its own |
| `max_turns` | int 1–5 | 3 | Search/planning rounds. Use 1–2 for orientation, 4–5 for complex cross-module tracing |
| `max_results` | int 1–30 | 10 | Maximum candidate files. Prefer 3–8 for focused work |
| `exclude_paths` | string[] | `[]` | Extra names to exclude from the repo map, on top of defaults |

## Parameters (web_search)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Web search query. Be specific: product names, versions, error text |
| `max_results` | int 1–10 | 5 | Results to return |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SEARCH_KEY` | — | Devin key for headless runs, when no key file exists |
