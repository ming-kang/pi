# Web Search

`web_search` is a Pi-native tool for querying live web information through MiniMax and DeepSeek search engines.

When both engines are configured, searches run concurrently and results are fused: URLs are normalized (tracking parameters and fragments stripped), duplicates merged, and hits verified by both engines rank first.

| Engine mode | Requirement |
|---|---|
| `dual` | Both MiniMax and DeepSeek keys configured |
| `minimax` | Only a MiniMax key configured |
| `deepseek` | Only a DeepSeek key configured |
| `none` | No key found — the tool reports itself disabled |

## Credentials

Keys are resolved per provider through the runtime's canonical auth chain (`ModelRuntime.getAuth`: runtime API key → `auth.json` → `models.json` → environment). When no runtime is available (or it does not know the provider), the extension falls back to reading `auth.json` directly (provider IDs `minimax-cn`, `minimax`, `deepseek`, including command-configured keys such as `"!op read ..."`) and then the environment variables `MINIMAX_CN_API_KEY`, `MINIMAX_API_KEY`, `DEEPSEEK_API_KEY`.

The MiniMax CN account (`minimax-cn`) is preferred over the global one (`minimax`) and selects the `api.minimaxi.com` search host; the global account uses `api.minimax.io`, overridable via `MINIMAX_API_HOST`.

Configure with `/login minimax-cn` or `/login deepseek`, or by exporting the environment variables above.

## Usage

### Parameters

- `query`: the search query — 3–5 keywords work best.
- `allowed_domains`: optional list of domains to include (e.g. `["github.com", "react.dev"]`).
- `blocked_domains`: optional list of domains to exclude.

`allowed_domains` and `blocked_domains` are mutually exclusive; if both are supplied, `allowed_domains` wins. Domain filters apply both in the upstream query and as a local post-filter on result URLs (subdomains included).

### Output

The model-facing payload is Markdown containing up to 12 verified sources (snippets bounded to 200 characters each, dual-engine hits tagged), a DeepSeek synthesis section when available, and up to 8 related searches, followed by a requirement to cite a `Sources:` section.

## Limits

- No configured key disables the tool with an explanatory message instead of failing the run.
- Engine failures are independent: if one engine errors, the other's results are still returned; the tool errors only when every configured engine fails.
- MiniMax search uses the Coding Plan Search endpoint (`POST /v1/coding_plan/search`), which requires a Coding Plan key — a standard MiniMax API key may be rejected upstream.
- DeepSeek search goes through the Anthropic-compatible endpoint (`/anthropic/v1/messages`, model `claude-sonnet-search`) with the server-side `web_search_20250305` tool; the synthesis text is bounded by the request's `max_tokens` (1024).
- Requests time out after 60 seconds (MiniMax) or 90 seconds (DeepSeek) and surface as Pi tool errors; upstream error bodies are truncated to 200 characters.

## Implementation notes

The extension keeps presentation Pi-native: the call line shows the query and active domain filters, in-flight renders show the engine badge with elapsed time, the collapsed result shows hit count, engines, and duration with the configured expand hint, and expanding renders the full Markdown payload.

Credential resolution never inspects `getProviderAuthStatus` — that probe returns a truthy `AuthStatus` object even when nothing is configured and carries no key. Only `getAuth` returns usable key material.
