# search — Devin code search and web search

Two tools powered by Devin's hosted backends, sharing one Devin key:

| Tool | What it does | Backend |
|---|---|---|
| `code_search` | Semantic code discovery in the local repo | Devin SWE-grep agent loop over the reverse-engineered Windsurf protocol |
| `web_search` | Live web search | Devin `GetWebSearchResults` (JSON) |

`code_search` sends your query plus a compact repo map to Devin, which plans a
small number of restricted search commands (`rg`/`readfile`/`tree`/`ls`/`glob`)
and returns candidate files with line ranges and grep keywords. **This extension
executes those commands locally in a strict sandbox**: every path is confined to
the current working directory, symlinks are refused, `.gitignore` and default
noise directories are honored, and file contents are never sent back. Results
are a reading list, not evidence — read the returned ranges with `read` and
verify with `grep` before editing.

`web_search` sends the query and returns titles, URLs, dates, and snippets.
Snippets are truncated and the key is redacted out of all backend responses
before parsing.

## Getting a key

Both tools stay hidden from the model until a Devin key exists. Configure it in
one of three ways:

- **`/search-key`** — paste a Devin token (`devin-session-token$<JWT>`) into the
  input dialog. Submit an empty field to clear the saved key. The dialog warns
  when the value looks truncated (a `$` eaten by shell or config expansion).
- **`/search-login`** — OAuth, no browser automation: the command shows an
  authorize URL (`app.devin.ai/auth/cli/continue`, PKCE S256), you sign in and
  copy the one-time authorization code, then paste it into the second dialog.
  The code is exchanged at `api.devin.ai/auth/cli/token` and the resulting
  session token is saved. There is no local HTTP listener and no refresh grant.
- **`SEARCH_KEY`** environment variable — for headless and CI runs. Used only
  when no key file exists.

`/search-status` shows the current key (masked) and its source
(`saved (manual)`, `saved (oauth)`, or `from SEARCH_KEY`). `/search-logout`
clears the stored key and disables both tools.

The key is persisted to `~/.pi/agent/search/config.json` (mode `0600`, directory
`0700`), separate from Pi's own `auth.json`. It is never passed to the model, and
`code_search` error output never includes it.

## Security model

Enforced by this extension, not by the remote backend:

- **Path containment.** Every model-supplied path passes through `PathSandbox`
  and must resolve inside the current working directory; `..` sequences, other
  drives, and symlinks are rejected before any filesystem access.
- **Read-only execution.** Only the five structured commands above exist. No
  shell, no writes, no model-controlled regular expressions (`rg` is a literal
  pattern, `glob` supports only `*` and `?`).
- **Bounded work.** Per-file 512 KiB, 400 lines per read window, a total output
  byte budget, and a per-request timeout cap every search.
- **No local credential discovery.** The extension never reads Devin/Windsurf
  IDE databases, CLI credentials, or other applications' state. Keys come only
  from `/search-key`, `/search-login`, or `SEARCH_KEY`.
- **TLS is never downgraded.** Network errors do not disable certificate
  validation.

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
| `FC_REPO_MAP_MODE` | `hotspot` | `hotspot` (shallow base + ranked subtrees) or `classic` (flat adaptive tree) |
| `FC_HOTSPOT_*` | — | Hotspot tuning: base depth, top-K, subtree depth, byte budget |

## Status

Unofficial integration. The backend protocol is reverse-engineered and can
change without notice, breaking search until the extension is updated. Not
affiliated with or endorsed by Pi or Devin.
