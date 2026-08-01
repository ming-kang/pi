# `router` — Codex-style API relays

`/router` connects Pi to OpenAI-compatible API relays — self-hosted gateways such as sub2api, CPA, or codex2api, and any similar proxy — using a **Codex-shaped** Responses client.

Configuration lives at `~/.pi/agent/router.json`.

Providers are registered at extension load via `pi.registerProvider` (config form + `streamSimple`). They do **not** go through `models.json`. This follows Pi's documented custom-provider path ([providers.md](../../providers.md), [custom-provider.md](../../custom-provider.md)): the stream wraps the built-in `openAIResponsesApi()` from `@earendil-works/pi-ai/compat` (same approach as the GitLab Duo example), then reshapes the request for Codex-style relays.

---

## Usage

```
/router          Browse relays
/router add      Add a relay
/router reload   Re-register from disk
/router <id>     Open a relay
```

### UI map

```
API relays                  ← relays first; add / reload at bottom
 └─ Relay · {id}            ← models · base URL · API key · remove
     └─ Models              ← searchable model list + fetch / manual add
         └─ {model id}      ← display name · thinking levels · remove
```

Edits **auto-save** to `router.json` and re-register the provider. Text fields save when confirmed; model and thinking toggles save immediately. There is no Save or Apply step, and Back never discards a completed change.

Model search follows Pi's `/model` behavior: the search field is always visible, typing fuzzy-filters results, arrows wrap around the list, Enter opens the highlighted item, and Esc goes back. Catalog checkboxes use Space to toggle live; Enter or Esc returns to the model list. The model currently used by the session is protected and must be changed with `/model` before it can be disabled or removed.

### Add flow

1. **Name** — provider id (e.g. `my-relay`); appears as `my-relay/gpt-5.6-sol` in `/model`
2. **Base URL** — usually ends with `/v1`
3. **API key** — literal `sk-…` or `$ENV_VAR`
4. The relay connection is written immediately, even before models are fetched.
5. **Fetch models** — `GET {baseUrl}/models`
6. **Select** — Space toggles each model immediately. If fetching fails, retry or add model ids manually.

A failed or cancelled catalog fetch does not lose the relay. Each selected model gets these defaults:

| Field | Default |
|:-:|:-:|
| `name` | **Omitted** — `/model` shows the model **id** |
| `reasoning` | `true` |
| `input` | `text` + `image` |
| `contextWindow` | 272000 |
| `maxTokens` | 128000 |
| `thinkingLevelMap` | `off` / `minimal` hidden; `low` / `medium` / `high` / `xhigh` / `max` enabled |

### Customize models

Relay → **Models** → pick a model:

- **Display name** — optional label (e.g. `Luna`). Leave empty to show the id. Saved on input confirmation.
- **Thinking levels** — router models expose only `low`, `medium`, `high`, `xhigh`, and `max`. All five start enabled; toggle any one to hide or re-enable it. `off` and `minimal` are never shown.
- **Remove model** — confirms and immediately removes the model from the relay. The model currently used by the session must be changed with `/model` first.

---

## Config shape

```jsonc
{
  "version": 1,
  "relays": [
    {
      "id": "my-relay",
      "baseUrl": "https://relay.example/v1",
      "apiKey": "sk-…",
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
            "xhigh": "xhigh",
            "max": "max"
          }
        },
        {
          "id": "gpt-5.6-luna",
          "name": "Luna",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  ]
}
```

There is **no migration** from any older models-manager config, and Pi updates do not overwrite `~/.pi/agent/router.json`. Existing router thinking maps are not automatically rewritten. At runtime, omitted thinking levels are filled from the five-level GPT Gateway defaults while explicit `null` values remain hidden. Legacy `off` / `minimal` entries are ignored at runtime and remain hidden; newly added models use the same five-level defaults.

---

## Limits

- SSE only — no Codex WebSocket or zstd-compressed request body.
- Catalog probe expects OpenAI-style `{ data: [{ id }] }` response format.
- Empty model list → provider is not registered (nothing appears in `/model`).
- Body is Codex-oriented for transparent gateways; auth and URL remain Platform Responses (`sk-` + `/responses`).
- Replayed optional top-level `ResponseItem.id` identity fields are omitted from stateless requests, matching Codex CLI 0.145's default `store: false` wire behavior. Required semantic references such as `item_reference.id`, plus `call_id` and encrypted reasoning content, remain intact.
- Same relay + same model: tool/reasoning multi-turn matches Codex-style Responses. Switching model or provider mid-session may normalize tool-call ids more strictly (upstream allow-list); this is not worked around here.
- Interactive `/router` requires a TUI (`ctx.hasUI`); otherwise a warning is shown and no dialog opens.
- Router models are GPT Gateway models: only `low`, `medium`, `high`, `xhigh`, and `max` are exposed. `off` and `minimal` are disabled.
- Catalog selection and thinking changes are live and auto-saved; Esc only returns to the previous screen.
- The active model and its provider cannot be disabled or removed; switch with `/model` first.
- If a catalog does not return an already configured model, the model remains listed as unavailable instead of being silently removed.
- A catalog probe does not send an unresolved environment or command-based key anonymously; it explains the local key problem and offers manual model entry.

## Implementation notes

**Request shape.** `stream.ts` calls `openAIResponsesApi().streamSimple` with a model configured as Platform Responses (`api: "openai-responses"`). The `onPayload` callback reshapes the body toward Pi's built-in `openai-codex-responses` format, with `store: false`, system prompt as `instructions`, `parallel_tool_calls: true`, and rejected fields such as `prompt_cache_retention` and `temperature` dropped. Before sending, it omits each recognized ResponseItem variant's optional top-level identity `id`, matching the released Codex CLI 0.145 default for non-Azure `store: false` requests; this prevents a relay-supplied generic `item_*` id from later being validated as a reasoning (`rs_*`), message (`msg_*`), or function-call (`fc_*`) id. IDs that are required semantic references on other input variants are not removed.

Session affinity headers use hyphenated form (`session-id`, `x-client-request-id`). Compat settings: `sessionAffinityFormat: "openai-nosession"`, `supportsLongCacheRetention: false`. Originator header: `codex`.

**Differences from ChatGPT Codex OAuth.** Auth uses Bearer `sk-…` (not OAuth JWT), endpoint is `{baseUrl}/responses` (not `/codex/responses`), transport is SSE only (no WebSocket or zstd), and `OpenAI-Beta` is not set. These match **sk- relays**, not the official ChatGPT backend.

**Multi-turn tool calls.** `call_id` remains the stable tool-call/result join key, while optional replay-only ResponseItem identity IDs are omitted. Encrypted reasoning content and required semantic reference IDs are still replayed, so fixed-relay, fixed-model sessions retain stateless reasoning continuity without depending on a relay's item-ID namespace. Switching models or providers can still trigger pi-ai's stricter tool-call normalization.
