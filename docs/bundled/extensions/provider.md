# Provider

Minimalist visual editor for the `providers` record of `models.json` (`~/.pi/agent/models.json`; respects `PI_CODING_AGENT_DIR`). The extension never registers runtime providers and stores no parallel configuration; Pi's native [models.json](../../models.md) mechanism remains the source of truth. See [Providers](../../providers.md) for credential setup and runtime resolution.

## Usage

`/provider` requires interactive TUI mode. The provider list and the editor share one frame height, so opening a provider never resizes the dialog. The frame has a 14-row body, growing to 18 rows on terminals tall enough to keep the transcript in view, where a model's whole page fits without scrolling. Leaving an editor returns the list to that provider's row.

```text
/provider         Open the searchable provider list (+ Add provider; Enter on a fruitless search creates that id)
/provider <id>    Jump straight into a provider editor, custom or built-in
```

The list shows your custom providers, then the configured built-in providers. A built-in counts as configured when it has any credential (an API key or OAuth login saved by `/login`, an environment variable such as `DEEPSEEK_API_KEY`, a `models.json` key, or a `--api-key`), or a `models.json` entry. The model in use plays no part: `/provider` edits configuration, and `/model` picks the model. Built-ins carry a dim note naming the credential source, e.g. `deepseek · built-in · API key` or `kimi-coding · built-in · OAuth`, and `customized` once `models.json` has an entry for them.

Every other built-in sits behind the dim `More built-in providers` row at the bottom, which opens a searchable list of them with their catalog sizes; Esc returns to the main list. A search in the main list covers the unconfigured built-ins too, listed after the configured matches as `built-in · not configured`, so typing `openrouter` finds it without opening More.

## Editor layout and controls

`/provider` presents a two-pane editor on wide terminals:

- **Left column:** Navigation grouped into `SETUP` (Authentication and Fetch models), `MODELS` (display name → `id` → `"New model"` draft fallback; at most one draft at a time), and `MANAGE` (`+ Add model` and `Delete provider`). The heading reads `MODELS · none yet` while a custom provider has no models, and the session's model is marked `· in use`. Built-in providers swap Fetch models for `Built-in models` and Delete for `Reset provider`; see [Built-in providers](#built-in-providers).
- **Right column:** A contextual page title above the selected item's field pane and sub-pane stack. Nested titles show their path, such as `Authentication / API Type`.

Below 72 columns, the editor shows only the focused pane: Enter or Right opens the detail view, and Escape or Left returns to navigation. Both layouts retain the same controls and fixed frame height.

Both columns keep independent selection and scroll positions. Instead of resizing, each column scrolls inside a fixed window with a `(n/N)` position indicator (the `/model` selector convention), and pinned rows such as filter inputs and error lines stay on screen. Exactly one accent `›` selection marker is shown at any time — the pane holding keyboard focus; unfocused panes keep their content readable without any selection marker.

Fixed fields keep their `Key: ` prefix while editing, and the selected key and value are highlighted together. Typing or pasting replaces the value; Enter opens the existing value for adjustment. Escape cancels that edit. The footer lists only the keys the selected row answers to.

### Key controls

| Key | Default | Action |
|---|---|---|
| `↑` / `↓` | `up` / `down` | Navigate rows (wraps at list boundaries) |
| `←` | `app.provider.switchPaneLeft` (`left`) | Focus the left navigation pane |
| `→` | `app.provider.switchPaneRight` (`right`) | Focus the right detail pane (never activates an action row, so it shows that row's explanation instead) |
| `Enter` | `enter` | Tweak a value, enter a sub-pane, or activate the selected action row (Fetch models, Built-in models, + Add model, Delete or Reset provider) |
| Printable typing | | Overwrite the highlighted text or numeric value |
| `Space` | `app.list.toggle` (`space`) | Toggle booleans and checklist items |
| `Ctrl+X` | `app.provider.removeEntry` (`ctrl+x`) | Remove the selected compat or dictionary entry. On a model in the left column: delete it, or reset a built-in model's overrides, after a confirm; cancelling returns to the list |
| `Ctrl+A` | `app.provider.checkAll` (`ctrl+a`) | In Fetch models results, check every listed model that can be added, or clear them when all are checked; follows the filter |
| `Esc` | `escape` | Cancel the current edit, discard a model draft (confirming when it has fields), pop the sub-pane, or return to the provider list |

### Adding a provider

Type the new id in the list search and press Enter: when nothing matches, the provider is created at once and opens on its API Type picker. The picker starts on the first protocol in the list and recommends none: which one is right depends on the endpoint, so each common tag names the route it calls (`Anthropic /v1/messages`, `OpenAI /v1/responses`, `OpenAI /v1/chat/completions`), which is how an endpoint's own documentation names its protocol. Enter on a protocol opens `baseUrl` for editing, with the shape that protocol expects as a placeholder, so the next paste fills it. Enter on the first `baseUrl` moves straight to an empty `apiKey` (a literal key, `$ENV_VAR`, or `!command`). Enter on the key fetches the endpoint's model list, ready to check and import. For a keyless local server press Escape on `apiKey`: setup lands on Fetch models without sending a request, and Enter starts it. Provider ids cannot contain spaces or start with `/` (a slash command typed into the open panel); an inner `/`, as in `acme/eu`, works because `provider/model` references match the longest known provider id. A new provider left with nothing but an API type or name is not written to `models.json` and is dropped when you return to the list.

## Provider configuration

### Authentication

Configures how Pi reaches and authenticates with the provider, in one page:

- **`baseUrl`**: Endpoint URL (for example, `http://localhost:11434/v1`). The expected shape depends on the API type: OpenAI-style APIs need the version path in the URL (`https://api.openai.com/v1`), while the Anthropic and Mistral clients append `/v1` themselves (`https://api.anthropic.com`). For `anthropic-messages`, `openai-responses`, `openai-completions`, and `mistral-conversations`, a custom provider's page shows the resulting address, such as `Requests go to https://gw.example/v1/messages`, and warns when `/v1` is doubled (`…/v1/v1/messages`). Model discovery tolerates both shapes, so a fetched model list does not prove the address is right; this line does. Other API types, and a page with no `baseUrl` yet, state the convention instead.
- **`apiKey`**: Provider API key or credential expression. Literal keys are masked in the display (e.g. `••••••1234`), while environment variable references (`$VAR`) and command substitutions (`!command`) are displayed verbatim. Values are stored raw in `models.json`; variable and command references resolve dynamically at request time.
- **API Type**: Opens a single-select picker over Pi's supported API protocols. The three that custom endpoints speak come first, each with the route it calls:

1. `anthropic-messages`
2. `openai-responses`
3. `openai-completions`
4. `google-generative-ai`
5. `azure-openai-responses`
6. `openai-codex-responses`
7. `mistral-conversations`
8. `google-vertex`
9. `bedrock-converse-stream`
10. `pi-messages`

Custom `api` strings already present in `models.json` are preserved. The provider API type can be cleared when every model defines its own `api` (see Model-specific API); on a built-in provider the catalog defaults apply.

- **Precedence hints**: When a higher-priority credential source is active (such as a saved token in `auth.json` or an environment variable), an informational notice indicates that the higher-priority source takes precedence over the `apiKey` row. An `apiKey` set here outranks the environment, so that notice hides as soon as one is entered.
- **Advanced**: Rarely edited provider fields, summarized on the row as `· none set` or `· set: …`. See [Advanced fields](#advanced-fields).

## Model configuration

Selecting a model in the left column displays its editable fields in the right column:

- **`id`**: Model identifier (required, unique per provider). Renaming waits for a successful save before switching the editor to the new id; conflicts leave the original model selected.
- **`name`**: Human-readable display name. When unset, interfaces fall back to showing the `id`.
- **`reasoning`**: Boolean toggle (`true`, `false`, or unset).
- **`thinkingLevelMap`**: Sub-pane configuring mappings for all seven Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Enter on a level shows its three states, with `●` on the current one:
  - **`Custom: <value>`:** Maps the level to a provider effort string. Enter edits the value in place (typing replaces it), as on the `id` and `name` rows; on a built-in model with no override, Enter starts from the catalog effort.
  - **`Default`:** Removes the key, falling back to Pi's default level handling. On a built-in model it reads `Default · built-in: <value>` (adding `, removes the override` once the level is overridden): overrides merge over the catalog map, so removing the key restores the built-in mapping (use Hidden to hide a built-in level).
  - **`Hidden`:** Writes `null`, hiding the level from selection.
- **`input`**: Modality checkboxes for `text` and `image`. At least one input modality must remain selected.
- **`cost`**: Sub-pane for $/M-token rates (`input`, `output`, `cacheRead`, `cacheWrite`). The row lists them in that order, such as `cost: 10 / 50 / 1 / 12.5`, with `-` for an unset rate; the sub-pane names each rate and holds any tiers. Edits require a complete cost object (unspecified rates default to `0`). Existing cost `tiers` are preserved; edit them under Advanced.
- **`contextWindow`**: Positive integer total context token limit. Both token fields also accept `500k`, `1.5m`, or `500,000`, and show a short form beside a count of 100,000 or more (`1048576 · 1.0M`).
- **`maxTokens`**: Positive integer maximum generation token limit.
- **`compat`**: Sub-pane configuring flags consumed by the selected API implementation. Open dictionary fields (`chatTemplateKwargs` and `chatTemplateArgs`) allow arbitrary keys and Pi thinking variables, including `thinking.budget`. Nested JSON values use the core models.json validation rules. The page describes the selected key under the list, the key picker lists each key with its description, and a choice field opens on its current value. Pressing `Ctrl+X` removes an entry to restore inherited behavior.
- **Advanced**: Rarely edited model fields. See [Advanced fields](#advanced-fields).
- **Model-specific API**: Sub-page for model-level `baseUrl` and API Type overrides. Rows display the inherited provider or built-in value dimmed; editing a value writes an override for this model only, and clearing it returns to inheritance.

The active session model and its provider cannot be deleted or renamed; switch models with `/model` first.

## Advanced fields

`Advanced` rows open a page of fields most setups never touch. Each row edits one `models.json` path:

| Page | Fields |
| --- | --- |
| Authentication | `name`, `headers`, `authHeader`, `compat` (provider-level, applies to every model of the provider) |
| Model | `headers`, `samplingParams`, `samplingParamsByThinkingLevel`, `promptCache`, `inputLimits`, `cost.tiers` |

`name` is plain text and `authHeader` cycles `true` → `false` → not set with `Space` or `Enter`. Every other value is one line of JSON, for example `{"X-Title":"pi"}` for `headers` or `{"temperature":0.3}` for `samplingParams`. A value is checked against the models.json schema before it is written, and the error names the failing path, such as `promptCache.short: must be > 0`. An empty value clears the field. Provider `compat` opens the same page as model `compat`, resolved against the provider's API type.

On a built-in model the page writes `modelOverrides`: catalog values render dim, and an entered value starts empty and is written as the override alone. Object fields merge over the catalog value the way `modelOverrides` always do, and `cost.tiers` replaces it.

## Built-in providers

Opening a built-in provider edits only what `models.json` changes about it; an untouched built-in writes nothing.

- **Authentication** leads with the provider's **Credential**, read from Pi's auth state and never shown in full: `API key ••••abcd · saved by /login`, `OAuth · <account> · expires <time>` (`OAuth · logged in` when neither is known), `from env DEEPSEEK_API_KEY`, or `not set`. Typing or pasting a key there saves it to `auth.json` exactly as `/login` does, replacing a stored key or OAuth login; `$VAR` and `!command` references are refused, since they belong in `models.json`. `Log out` appears while `auth.json` holds a credential and removes it after a confirm. OAuth sign-in stays with `/login <provider>`. The `apiKey` row appears only once `models.json` sets one.
- The same page shows the catalog `baseUrl` dimmed until overridden; clearing an override restores it. API Type is hidden, because a provider-level `api` never reaches catalog models (it reappears when `models.json` already sets one for custom models). Fetch models is replaced by the catalog itself.
- **Built-in models** opens a searchable list of the provider's catalog. Enter opens a model's page over the list (`Built-in models / <model>`), and `Esc` returns to the list with its search kept. The page edits the model's `modelOverrides` entry: inherited catalog values render dim, overridden ones are lit and marked `· overridden`, and clearing a field drops just that key. `Reset to built-in` removes the model's whole entry. Once a model has an override it is also listed under `MODELS`; untouched catalog models stay behind Built-in models. The id, `api`, and `baseUrl` of a catalog model are not overridable.
- **Custom models** added with `+ Add model` are written to `models`; a row is marked `· replaced` when its id replaces a catalog model and `· custom` otherwise.
- **Reset provider** replaces Delete provider and removes the provider's `models.json` entry; built-in models, endpoints, and stored credentials stay. It is refused only while the current model is one `models.json` defines.

Emptied override objects are pruned as they empty, and a built-in entry with nothing left is removed rather than kept as `{}`.

## Fetch models

For OpenAI-compatible APIs, discovery uses `GET {baseUrl}/models`. Anthropic Messages uses `{baseUrl}/v1/models`, without repeating an existing `/v1` suffix. The pane's idle action row shows the discovery URL; `Enter` starts the request. Without a `baseUrl`, the pane instead explains what to configure and discovery cannot start. Discovery is optional: when an endpoint has no model list, add its models by id with `+ Add model`.

Accepted catalog shapes are `data[]`, `models[]`, or a bare array. Entries can provide `id` or `slug`, plus an optional `name`, `display_name`, or `displayName`. Alongside the identifier and label, discovery imports the metadata an entry declares under the common field names — `context_window` / `context_length` / `max_model_len`, `max_output_tokens` / `max_tokens`, image input via `input_modalities` or an explicit vision flag, and reasoning via a supported-effort list or a capability flag. Only positive integers count (`0`, `null`, decimals, and non-numeric values are ignored); where fields disagree the smallest value wins, because an overstated limit overflows requests while an understated one only compacts earlier. Native Google catalog shapes are not supported.

- **Authentication:** Credentials resolve through Pi's canonical resolution chain. Header-only resolved authentication is supported, and the default scheme follows the API type. Unsaved connection changes block discovery. Raw `$VAR` or `!command` placeholders are never transmitted unresolved; discovery aborts if configured credentials cannot be resolved. Known resolved credentials are redacted from server errors.
- **Anthropic-compatible gateways:** Anthropic Messages catalogs are often served OpenAI-style only, so a `401`, `403`, or `404` on the Anthropic path triggers exactly one retry with `Authorization: Bearer` at the same URL, or at the base URL with a trailing `/anthropic` removed. Both attempts stay on the original origin, an explicitly configured `Authorization` header is never overridden, and other API types are never retried. A failed retry reports both URLs and their status codes.
- **Pagination:** Anthropic catalogs answer with their `has_more` marker; discovery follows that marker through `after_id` (up to five pages) instead of reporting the first 20-entry page as partial. Every other catalog is fetched once and a response declaring `has_more` is still marked partial.
- **Limits:** Discovery has a 10-second deadline covering the whole attempt sequence, including preparation, authentication waits, retries, and pagination. Responses are bounded to 4 MiB (error payloads are bounded to 4 KiB and displayed up to 400 characters). Catalogs are capped at 2,000 models.
- **Checklist import:** Discovered models appear in a searchable checklist. Models already configured in `models.json` are marked `added` and cannot be checked. Each row shows the metadata it declared, e.g. `deepseek-flash · DeepSeek-V4.1-Flash · 1.0M ctx · 393k out · img · think`. `Ctrl+A` checks every listed model that can be added, so filtering to `claude` and pressing it selects that family. Confirming imports the checked models — or just the highlighted one when nothing is checked — with that metadata, saves immediately, and refreshes the provider runtime. `Esc` discards the results.

Imported metadata lands in the same fields the editor already manages, so `contextWindow`, `maxTokens`, `input`, and `reasoning` remain editable afterwards. Cost is never imported: catalog pricing dialects differ in both unit and precision, and a misread rate misreports spend by orders of magnitude.

## Use built-in data

The `Use built-in data` row in a model's field list provides field-level completion from Pi's built-in model catalog:

- **Matching:** Queries Pi's catalog using exact ID matches first, then normalized ID comparisons, then fuzzy search. Ties prefer entries sharing the model's effective API protocol. Up to 8 candidates are presented, each with what sets it apart: `moonshotai / kimi-k3 · 1.0M ctx · 131k out · img · think`, plus its API when that differs from the model's.
- **Preview:** Selecting a candidate displays a per-field comparison (`current → reference`). A field the model already has at the reference value is listed dim as `· already set`, without a checkbox. The last row counts what will be written (`Apply 2 fields`). Applying verifies that the model and its effective API still match the preview. Existing cost tiers and unrelated nested compatibility entries are retained.
- **Default selections:** Unset scalar fields (`name`, `reasoning`, `input`, `contextWindow`, `maxTokens`) are pre-checked. Explicitly configured values remain unchecked. `thinkingLevelMap`, `compat`, and `cost` are always opt-in.
- **Safety boundaries:** Cross-API thinking maps and compat dictionaries are view-only and cannot be imported. Cost tiers from the reference are never imported. Identity and connection fields (`provider`, `id`, `api`, `baseUrl`, keys) are never altered. Pressing `Esc` discards the preview without applying changes.

## Persistence and runtime refresh

- **Atomic locking:** Edits save immediately. The editor title shows `Saving…` while a write is pending, `Saved` once the edits made in this editor are in the file, and `Save failed` when edits remain unsaved after an error. Writes acquire a cross-process lock via `proper-lockfile`, write to a temporary file in the same directory, validate the candidate file with `ModelConfig`, and atomically rename it into place.
- **Backup:** The first write over an existing file creates a `.bak` copy of its content. Symlinked configuration files are edited at their resolved target without replacing the symlink.
- **Formatting:** Saves edit the file in place: `//` comments, trailing commas, key order, and the formatting of untouched entries stay as written, and new entries follow the file's indentation (a one-line file stays on one line). A new file is written as two-space JSON. Unknown top-level and nested values are preserved.
- **Conflict resolution:** Every save re-reads the file under a cross-process lock and applies pending edits onto the freshest content, so unrelated external edits merge automatically and a same-field race resolves last-writer-wins. Edits targeting externally removed models simply miss, and the view resyncs onto the merged result after each save.
- **Runtime refresh:** An offline-scoped refresh (`allowNetwork: false`) synchronizes the runtime when `/provider` closes (or immediately following a Fetch models import). Save errors and runtime refresh errors are reported independently.
- **Recovery:** Failed edits remain pending and retry automatically with the next save. Closing offers return, retry, or explicit discard. Fetch refreshes retain the changed-model information needed to update the active session model on close. Leaving a pane cancels its outstanding discovery and prevents late results from changing another page.
- **Overlay behavior:** Configuring a provider whose ID matches a Pi built-in provider overlays that catalog; see [Built-in providers](#built-in-providers). `modelOverrides` take precedence over a `models` entry with the same id.

## Migration from router

The `provider` extension replaces the retired `router` extension.

- Existing `~/.pi/agent/router.json` and `~/.pi/agent/router-client.json` files remain on disk unmigrated for manual reference.
- The previous Codex 0.153.4-pinned relay request profile is discontinued. Requests now follow Pi's native API implementations and standard `models.json` `compat` options.
