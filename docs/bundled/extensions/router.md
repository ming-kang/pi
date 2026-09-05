# `router` — Codex-style API relays

`/router` connects Pi to OpenAI-compatible API relays — self-hosted gateways such as sub2api, CPA, or codex2api, and similar proxies — using a **Codex-shaped normal API-key Responses/SSE profile pinned to Codex 0.153.4**. This is a scoped request adaptation, not the full Codex client or a guarantee that a gateway cannot distinguish it from Codex.

Configuration lives at `~/.pi/agent/router.json`. A separate `~/.pi/agent/router-client.json` persists a non-secret installation identity when `/router` is opened or configured relays load. These paths follow Pi's agent directory when overridden.

Providers register at extension load through `pi.registerProvider` (config form + `streamSimple`), not through `models.json`. Following Pi's [custom-provider path](../../custom-provider.md) and [provider documentation](../../providers.md), the router wraps the public `openAIResponsesApi()` from `@earendil-works/pi-ai/compat`. **The published pi-ai adapter still owns message conversion, Responses streaming, SSE parsing, usage, and tool-call events.**

---

## Usage

```text
/router          Browse relays
/router add      Add a relay
/router reload   Re-register from disk
/router <id>     Open a relay
```

### UI map

```text
API relays                  ← relays first; add / reload at bottom
 └─ Relay · {id}            ← models · URL · key · catalog · provider name · remove
     └─ Models              ← searchable model list + fetch / manual add
         └─ {model id}      ← name · thinking map · context/output metadata
                              reasoning · image input · Codex settings · remove
```

Edits **auto-save** to `router.json` and re-register the provider. Text fields save when confirmed; catalog selections and completed thinking-map edits save immediately. There is no Save or Apply step, and Back never discards a completed change.

TUI model search follows Pi's `/model` behavior: the search field is always visible, typing fuzzy-filters results, arrows wrap, Enter opens the highlighted item, and Esc goes back. Catalog checkboxes use Space to toggle live; Enter or Esc returns to the model list. The active model and its provider cannot be disabled or removed; switch with `/model` first. Interactive `/router` requires `ctx.hasUI`; without it, the command warns and does not open. In a UI host without the TUI checklist, catalog import instead asks to import the full catalog.

### Add flow and discovery

1. **Name** — provider id, such as `my-relay`; appears as `my-relay/gpt-5.6-sol` in `/model`.
2. **Base URL** — usually ends with `/v1`; requests append `/responses` or `/models`. Use HTTP(S) without embedded credentials or a fragment. Existing query parameters are preserved.
3. **API key** — for example, a literal `sk-…` or `$RELAY_KEY`.
4. The connection is saved immediately, before discovery. A failed or cancelled fetch does not lose it.
5. **Fetch models**, then select models; retry or enter model ids manually if discovery fails.

The relay's **Catalog format** selects:

| Format | Request | Expected JSON |
|---|---|---|
| `openai` (default) | `GET {baseUrl}/models` | `{ "data": [{ "id": "…", "name": "…" }] }` (`name` optional) |
| `codex` | `GET {baseUrl}/models?client_version=0.153.4` | `{ "models": [{ "slug": "…", "display_name": "…" }] }` plus optional Codex metadata |

Codex discovery replaces any existing `client_version` parameter while keeping unrelated parameters. Both formats request JSON with the Codex identity headers and a default Bearer key. Resolved custom Authorization headers override that default, including explicit runtime `null` removal. Successful bodies are bounded to 4 MiB, non-OK text is read up to 4 KiB and displayed up to 400 characters, discovery times out after 10 seconds, and the sorted, deduplicated list is limited to 2,000 models.

For registered relays with models, discovery uses Pi's canonical provider-auth resolution, including resolved auth headers. A new empty relay is not registered yet: its fallback accepts only literal values, `$ENV_VAR`, or `${ENV_VAR}`. Unset variables, `!command` values, and mixed interpolation are not sent unresolved or anonymously. **Add a model manually first** to enable Pi's dynamic auth resolution, then fetch again. The same limited fallback applies to unresolved relay headers.

Fetching does **not overwrite existing selected model configurations**. Configured models missing from the catalog remain listed as unavailable. Codex metadata is imported only for newly selected models: display name, context bounded by `max_context_window`, supported effort mappings (`none` maps to Pi `off`), reasoning capability, text/image input, and supported summary/verbosity defaults. `max_context_window` is not an output limit: importing metadata caps the local default output count to the resulting context window instead.

### New-model defaults and customization

Manual additions and OpenAI catalog entries start with these defaults; Codex catalog metadata can refine them:

| Field | Default |
|---|---|
| `name` | Omitted unless a custom/catalog label exists; `/model` otherwise shows the id |
| `reasoning` | `true` |
| `input` | `text` + `image` |
| `contextWindow` | 272000 |
| `maxTokens` | 128000 (local metadata only) |
| `thinkingLevelMap` | `low`, `medium`, `high` mapped to themselves; `off`, `minimal`, `xhigh`, `max` set to `null` |

Relay → **Models** → model lets you edit:

- **Display name** — leave empty to show the id.
- **Thinking levels** — all seven Pi levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Each can inherit Pi behavior (omit the key), map to an arbitrary non-empty provider effort string, or be hidden (`null`).
- **Context window / Output tokens** — safe positive integer metadata, with explicit output no greater than context. An omitted output value is capped to the context window when defaults are resolved, so existing partial small-context entries remain valid. **`maxTokens` is local Pi metadata, not a server generation cap: the router removes `max_output_tokens` from the request.**
- **Reasoning / Image input** — capability toggles; these do not discover server support.
- **Codex request settings** — reasoning summary, verbosity, and parallel tool calls, as described below.
- **Remove model** — confirmation required; switch away from the active model first.

---

## Config shape

The format remains **version 1**, with additive optional fields. The file is strict JSON; unsupported fields are rejected. `api` is **not** a config field: provider and model registration automatically use `openai-responses`.

```json
{
  "version": 1,
  "relays": [
    {
      "id": "my-relay",
      "name": "My relay",
      "baseUrl": "https://relay.example/v1",
      "apiKey": "$RELAY_KEY",
      "catalog": "openai",
      "headers": { "X-Relay-Tenant": "example" },
      "models": [
        {
          "id": "gpt-5.6-sol",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": null,
            "max": null
          },
          "codex": {
            "reasoningSummary": "auto",
            "verbosity": null,
            "parallelToolCalls": true
          },
          "headers": { "X-Relay-Route": "standard" },
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  ]
}
```

Relay `name`, `headers`, and `catalog` are optional. Model `name`, `headers`, `cost`, and `codex` are optional alongside the existing capability and thinking fields. Config headers have string values; nullable header removals are available through Pi's runtime header hooks/options, not this JSON schema. Cost defaults to zero for all four Pi cost categories (rates per million tokens); it is accounting metadata, not a relay pricing lookup. Headers and cost can be edited in the file; the UI does not expose editors for them.

| `codex` field | Supported values | When omitted |
|---|---|---|
| `reasoningSummary` | `"auto"`, `"concise"`, `"detailed"`, `null` | `auto` for reasoning models; otherwise omitted from the wire |
| `verbosity` | `"low"`, `"medium"`, `"high"`, `null` | Omitted from the wire |
| `parallelToolCalls` | `true`, `false` | `true` |

For summary and verbosity, `null` explicitly omits the wire field. UI **Inherit** removes the setting and uses these defaults. Support comes from catalog metadata or explicit settings, not a guess based on the model id.

There is no migration from older models-manager configs, and Pi updates do not overwrite `router.json`. **Behavior change:** explicit existing thinking maps, including `off` and `minimal`, are now preserved. Omitted maps/entries follow Pi's semantics instead of the old router behavior that forced five enabled levels and ignored `off`/`minimal`. In particular, omitted `xhigh`/`max` are not enabled by the router. The conservative three-level map above applies only to newly created models; existing maps are not rewritten.

An empty model list means the provider is not registered and has no entries in `/model`.

## Request profile and lifecycle

### Identity and headers

The default originator is `codex_cli_rs`. The source-derived user-agent format is:

```text
codex_cli_rs/0.153.4 ({OS type} {OS version}; {architecture}) {terminal[/version]}
```

OS and terminal identity are **approximations**, not a copy of Codex's entire detection stack. Windows uses Node's OS release and normalized architecture; macOS uses `sw_vers` when available; Linux covers common `/etc/os-release` distributions, not the complete Rust `os_info` fallback matrix. Terminal detection uses environment variables and sanitizes the resulting token. In particular, it does not query tmux's underlying client or spawn zellij.

Defaults include `Accept: text/event-stream` and `Content-Type: application/json`. A final provider-scoped fetch boundary removes all `x-stainless-*`, `x-pi-*`, `x-session-affinity`, and underscore `session_id` headers after SDK assembly. Unrelated OpenAI SDK process defaults (`OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, and header names in `OPENAI_CUSTOM_HEADERS`) are suppressed unless explicitly configured for the relay. It does not restore removed/null user-agent, originator, content-type, or Accept defaults. Custom values supplied through Pi headers/options are otherwise respected, except that a present Accept on a Responses POST is normalized to `text/event-stream`; catalog GETs explicitly use `application/json`.

### Installation, session, and user-task state

- `router-client.json` contains `{ "version": 1, "installationId": "…" }`. The UUID persists across extension reloads/processes and is not a credential. An invalid existing identity file produces a load error rather than being silently replaced.
- A window UUID lives for one extension runtime, not one HTTP request. A full extension `/reload` creates a new window identity; `/router reload` re-registers providers and clears turn state without recreating the runtime.
- Pi's supplied session identity is used for both session and thread, and for `prompt_cache_key`. Unsafe/non-ASCII or overlong supplied ids are hashed; absent ids receive a fresh UUID. Nested callers need their own session id.
- Headers include `session-id`, `thread-id`, `x-client-request-id` (thread id), `x-codex-window-id`, and JSON `x-codex-turn-metadata`. Body `client_metadata` carries installation, session, thread, window, and user-task turn identifiers and turn-start time.
- Turn scope is keyed by session, provider, base URL, model, and latest user message. A tool-loop continuation keeps the same turn id/start time. The first valid successful response `x-codex-turn-state` token is retained and sent on subsequent requests in that scope; tokens are opaque, printable, bounded to 8 KiB, and never persisted.
- User-task start, session navigation/start (including `/tree`), model selection, shutdown, and provider re-registration clear turn scopes. This is not a fresh turn for each Pi tool-loop iteration.

### Payload and replay

The router moves only the leading system/developer prompt to `instructions`; later developer messages stay ordered in input. It sets `store: false`, `stream: true`, `tools` (empty if absent), `tool_choice: "auto"`, configured parallel tools, `include: ["reasoning.encrypted_content"]`, the cache key, and client metadata. Summary follows the table above; adapter-provided effort mappings remain intact, with `persistent` translated to `disabled`. Verbosity is sent only when configured.

Normal Codex DTO exclusions are removed: `prompt_cache_retention`, `prompt_cache_options`, `max_output_tokens`, `temperature`, `top_p`, `user`, `metadata`, `truncation`, `context_management`, `safety_identifier`, and `stream_options`.

Replay follows the 0.153.4 prefixed item-id rule, **not the old blanket removal of optional ids**: recognized item variants retain string ids with non-empty text on both sides of the first underscore; malformed unprefixed ids are omitted. Required semantic references such as `item_reference.id`, stable tool `call_id` joins, and encrypted reasoning content remain intact. Status fields on selected replay variants and output-text annotations are removed. Pi-ai still owns conversion, and switching model/provider can trigger its stricter tool-call normalization; the router does not work around that.

### HTTP retries versus Pi agent behavior

The scoped HTTP transport defaults to **four retries** after the initial attempt for HTTP 5xx and recognized network errors, with 200 ms exponential backoff and 0.9–1.1 jitter. It does **not** retry HTTP 429. Caller `maxRetries` and `maxRetryDelayMs` options can alter this policy; aborts and non-replayable streaming request bodies are not retried. The adapter's own HTTP retry layer is disabled (`maxRetries: 0`) to avoid stacking policies. Successful response bodies/SSE remain with pi-ai.

This is only the HTTP policy. **Outer Pi agent retries, tool execution, context management, and compaction remain Pi behavior**, not Codex stream recovery or the full Codex agent loop.

## Supported scope and remaining limits

- Supported target: normal **API-key-authenticated Responses POSTs over SSE**, plus OpenAI/Codex catalog GETs. Auth remains Bearer API key and the endpoint is `{baseUrl}/responses`, not automatically the ChatGPT OAuth `/codex/responses` endpoint. No `OpenAI-Beta` default is added.
- No Codex account identity, ChatGPT account headers, attestation, credential reading, WebSocket transport, zstd request compression, Responses Lite, or remote-compaction clone is implemented.
- HTTP/TLS fingerprinting, complete Rust OS/terminal detection, Codex prompts/tools, and complete agent/retry behavior are outside this profile. Matching headers and selected payload fields does not make Pi indistinguishable from the official binary.
- User `before_provider_request` hooks run after shaping and may replace/override the payload. `before_provider_headers` hooks and custom stream options can alter header values or behavior, subject to the final cleanup above. Such customizations affect fidelity to this documented profile.
- Local HTTP receiver tests cover headers/payloads, multi-turn tools and encrypted reasoning, hooks, cancellation, and related state/transport/catalog/configuration behavior. A real Windows ConPTY check exercised model edits, `/reload`, `/tree`, and pending/settled/collapsed/expanded tool presentation with a synthetic loopback provider. **Official binary downloads from GitHub and npm timed out, and no target gateway has been verified.** This is source-guided adaptation with local coverage, not a successful official-binary differential capture or a claim of perfect relay compatibility.

### Pinned upstream sources

The reference is the released **`rust-v0.153.4`**, commit **`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`**, not `main` or a moving latest-version URL:

- [Codex 0.153.4 release](https://github.com/openai/codex/releases/tag/rust-v0.153.4)
- [Commit-pinned source tree](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs) — client identity, Responses request/response types, terminal detection, and model catalog behavior.
- [HTTP retry implementation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-client/src/retry.rs)
- [Provider defaults](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/model-provider-info/src/lib.rs)

These release-pinned references define the intended supported profile; the limits above describe where this implementation does not reproduce the upstream client.
