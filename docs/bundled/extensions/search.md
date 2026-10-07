# Search

Two tools powered by Devin's hosted backends, sharing one Devin key:

| Tool | What it does | Backend |
|---|---|---|
| `code_search` | Semantic code discovery in the local repo | Devin SWE-grep agent loop |
| `web_search` | Live web search | Devin `GetWebSearchResults` JSON |

`code_search` sends your query plus a compact repo map to Devin, which plans a small number of restricted search commands (`rg`/`readfile`/`tree`/`ls`/`glob`) and returns candidate files with line ranges and grep keywords. **This extension executes those commands locally in a strict sandbox**: every path is confined to the current working directory, symlinks are refused, `.gitignore` and default noise directories are honored. What leaves your machine is the repo map of names and paths plus the contents of the files the backend asks to `readfile`. Results are a reading list.

`web_search` sends the query and returns titles, URLs, dates, and snippets. Snippets are truncated and the key is redacted out of all backend responses before parsing.

## Getting a key

Both tools stay hidden from the model until a Devin key exists. Configure it in one of three ways:

- **`/search-key`** — paste a Devin token (`devin-session-token$<JWT>`) into the input dialog. Submit an empty field to clear the saved key. The dialog warns when the value looks truncated (a `$` eaten by shell or config expansion).
- **`/search-login`** — OAuth, no browser automation: the command shows an authorize URL (`app.devin.ai/auth/cli/continue`, PKCE S256), you sign in and copy the one-time authorization code, then paste it into the second dialog. The code is exchanged at `api.devin.ai/auth/cli/token` and the resulting session token is saved. There is no local HTTP listener and no refresh grant.
- **`SEARCH_KEY`** environment variable — for headless and CI runs. Used only when no key file exists.

`/search-status` shows the current key (masked) and its source (`saved (manual)`, `saved (oauth)`, or `from SEARCH_KEY`). `/search-logout` clears the stored key and disables both tools.

The key is persisted to `~/.pi/agent/search/config.json`.

## Security model

Enforced by this extension, not by the remote backend:

- **Path containment.** Every model-supplied path passes through `PathSandbox` and must resolve inside the current working directory; `..` sequences, other drives, and symlinks are rejected before any filesystem access.
- **Read-only execution.** Only the five structured commands above exist: no shell and no writes. `rg` patterns are matched by the local ripgrep tool, which treats them as regular expressions, and `glob` is matched by a small local matcher that supports `*`, `?`, and `[...]`.
- **Bounded work.** Every command result is capped at `FC_RESULT_MAX_LINES` lines (default 50) with `FC_LINE_MAX_CHARS` characters per line (default 250), the repo map is trimmed to stay under 250 KiB, and each request runs under a timeout cap (`FC_TIMEOUT_MS`, default 30 s).

## Parameters (code_search)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Natural-language description of the behavior, flow, or concept to locate. English matches best; keep identifiers and error text verbatim |
| `project_path` | string | cwd | Subtree to search; must resolve inside cwd. Narrow it for monorepos |
| `tree_depth` | int 0–6 | 3 | Repo-map depth. Use 1–2 for huge repos, 4–6 only for small focused repos |
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
| `WS_MODEL` | `MODEL_SWE_1_6_FAST` | Backend protocol model id. Escape hatch for protocol drift; leave unset normally |
| `WS_APP_VER` / `WS_LS_VER` | `1.48.2` / `1.9544.35` | Protocol metadata versions |
| `FC_MAX_COMMANDS` | 8 | Max parallel commands per round |
| `FC_TIMEOUT_MS` | 30000 | Stream request timeout (ms) |
| `FC_RESULT_MAX_LINES` | 50 | Max lines in one command result (1–500) |
| `FC_LINE_MAX_CHARS` | 250 | Max characters in one result line (20–10000) |
| `FC_REPO_MAP_MODE` | `hotspot` | `hotspot` (shallow base + ranked subtrees) or `classic` (flat adaptive tree) |
| `FC_HOTSPOT_*` | — | Hotspot tuning: base depth, top-K, subtree depth, byte budget |
