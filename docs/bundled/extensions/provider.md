# provider — visual models.json editor

Minimalist visual editor for the `providers` record of `models.json` (`~/.pi/agent/models.json`; respects `PI_CODING_AGENT_DIR`). The extension never registers runtime providers and stores no parallel configuration; Pi's native [models.json](../../models.md) mechanism remains the source of truth. See [Providers](../../providers.md) for credential setup and runtime resolution.

## Usage

`/provider` requires interactive TUI mode. The provider list and the editor share the same fixed frame height, so opening a provider never resizes the dialog.

```text
/provider         Open the searchable provider list (+ Add Provider; a fruitless search prefills the new id)
/provider <id>    Jump straight into a provider editor
```

## Editor layout and controls

`/provider` presents a two-pane editor:

- **Left column:** Navigation list containing API Auth, Fetch Models, the provider's configured models (display name → `id` → `"New Model"` draft fallback; at most one draft at a time), `+ Add Model`, and `Delete Provider`.
- **Right column:** Hosts the selected item's field pane and sub-pane stack.

Both columns keep independent selection and scroll positions. The frame height is fixed: instead of resizing, each column scrolls inside a fixed window with a `(n/N)` position indicator (the `/model` selector convention), and pinned rows such as filter inputs and error lines stay on screen. Exactly one accent `›` selection marker is shown at any time — the pane holding keyboard focus; unfocused panes keep their content readable without any selection marker.

Fixed fields keep their `Key: ` prefix while editing, and the selected key and value are highlighted together. Typing or pasting replaces the value; Enter opens the existing value for adjustment. Escape cancels that edit.

### Key controls

| Key | Default | Action |
|---|---|---|
| `↑` / `↓` | `up` / `down` | Navigate rows (wraps at list boundaries) |
| `←` | `app.provider.switchPaneLeft` (`left`) | Focus the left navigation pane |
| `→` | `app.provider.switchPaneRight` (`right`) | Focus the right detail pane (never activates an action row) |
| `Enter` | `enter` | Tweak a value, enter a sub-pane, or activate the selected action row (Fetch Models, + Add Model, Delete Provider) |
| Printable typing | | Overwrite the highlighted text or numeric value |
| `Space` | `app.list.toggle` (`space`) | Toggle booleans and checklist items |
| `Ctrl+X` | `app.provider.removeEntry` (`ctrl+x`) | Remove the selected compat or dictionary entry |
| `Esc` | `escape` | Cancel the current edit, discard a model draft (confirming when it has fields), pop the sub-pane, or return to the provider list |

## Provider configuration

### API Auth

Configures the provider's connection in one page:

- **`baseUrl`**: Endpoint URL (for example, `http://localhost:11434/v1`). The expected shape depends on the API type: OpenAI-style APIs need the version path in the URL (`https://api.openai.com/v1`), while the Anthropic and Mistral clients append `/v1` themselves (`https://api.anthropic.com`). A hint line on the page states the convention for the selected API type.
- **`apiKey`**: Provider API key or credential expression. Literal keys are masked in the display (e.g. `••••••1234`), while environment variable references (`$VAR`) and command substitutions (`!command`) are displayed verbatim. Values are stored raw in `models.json`; variable and command references resolve dynamically at request time.
- **API Type**: Opens a single-select picker over Pi's supported API protocols. Common protocols are listed first:

1. `openai-responses`
2. `openai-completions`
3. `anthropic-messages`
4. `google-generative-ai`
5. `azure-openai-responses`
6. `openai-codex-responses`
7. `mistral-conversations`
8. `google-vertex`
9. `bedrock-converse-stream`
10. `pi-messages`

Custom `api` strings already present in `models.json` are preserved. The provider API type can be cleared when every model defines its own `api` (see Model-Specific API); on a built-in provider the catalog defaults apply.

- **Precedence hints**: When a higher-priority credential source is active (such as a saved token in `auth.json` or an environment variable), an informational notice indicates that the higher-priority source takes precedence over the `apiKey` row.

## Model configuration

Selecting a model in the left column displays its editable fields in the right column:

- **`id`**: Model identifier (required, unique per provider). Renaming waits for a successful save before switching the editor to the new id; conflicts leave the original model selected.
- **`name`**: Human-readable display name. When unset, interfaces fall back to showing the `id`.
- **`reasoning`**: Boolean toggle (`true`, `false`, or unset).
- **`thinkingLevelMap`**: Sub-pane configuring mappings for all seven Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Each level supports three states:
  - **String target:** Maps to a specific provider effort string.
  - **Hidden (`null`):** Explicitly hides the thinking level from selection.
  - **Inherit:** Removes the key, falling back to Pi's default level handling.
- **`input`**: Modality checkboxes for `text` and `image`. At least one input modality must remain selected.
- **`cost`**: Sub-pane for $/M-token rates (`input`, `output`, `cacheRead`, `cacheWrite`). Edits require a complete cost object (unspecified rates default to `0`). Existing custom cost `tiers` are preserved read-only.
- **`contextWindow`**: Positive integer total context token limit.
- **`maxTokens`**: Positive integer maximum generation token limit.
- **`compat`**: Sub-pane configuring flags consumed by the selected API implementation. Open dictionary fields (`chatTemplateKwargs` and `chatTemplateArgs`) allow arbitrary keys and Pi thinking variables, including `thinking.budget`. Nested JSON values use the core models.json validation rules. Pressing `Ctrl+X` removes an entry to restore inherited behavior.
- **Model-Specific API**: Sub-page for model-level `baseUrl` and API Type overrides. Rows display the inherited provider or built-in value dimmed; editing a value writes an override for this model only, and clearing it returns to inheritance.

The active session model and its provider cannot be deleted or renamed; switch models with `/model` first.

## Fetch Models

For OpenAI-compatible APIs, discovery uses `GET {baseUrl}/models`. Anthropic Messages uses `{baseUrl}/v1/models`, without repeating an existing `/v1` suffix. The pane's idle action row shows the discovery URL; `Enter` starts the request. Without a `baseUrl`, the pane instead explains what to configure and discovery cannot start.

Accepted catalog shapes are `data[]`, `models[]`, or a bare array. Entries can provide `id` or `slug`, plus an optional `name`, `display_name`, or `displayName`. Alongside the identifier and label, discovery imports the metadata an entry declares under the common field names — `context_window` / `context_length` / `max_model_len`, `max_output_tokens` / `max_tokens`, image input via `input_modalities` or an explicit vision flag, and reasoning via a supported-effort list or a capability flag. Only positive integers count (`0`, `null`, decimals, and non-numeric values are ignored); where fields disagree the smallest value wins, because an overstated limit overflows requests while an understated one only compacts earlier. Native Google catalog shapes are not supported.

- **Authentication:** Credentials resolve through Pi's canonical resolution chain. Header-only resolved authentication is supported, and the default scheme follows the API type. Unsaved connection changes block discovery. Raw `$VAR` or `!command` placeholders are never transmitted unresolved; discovery aborts if configured credentials cannot be resolved. Known resolved credentials are redacted from server errors.
- **Anthropic-compatible gateways:** Anthropic Messages catalogs are often served OpenAI-style only, so a `401`, `403`, or `404` on the Anthropic path triggers exactly one retry with `Authorization: Bearer` at the same URL, or at the base URL with a trailing `/anthropic` removed. Both attempts stay on the original origin, an explicitly configured `Authorization` header is never overridden, and other API types are never retried. A failed retry reports both URLs and their status codes.
- **Pagination:** Anthropic catalogs answer with their `has_more` marker; discovery follows that marker through `after_id` (up to five pages) instead of reporting the first 20-entry page as partial. Every other catalog is fetched once and a response declaring `has_more` is still marked partial.
- **Limits:** Discovery has a 10-second deadline covering the whole attempt sequence, including preparation, authentication waits, retries, and pagination. Responses are bounded to 4 MiB (error payloads are bounded to 4 KiB and displayed up to 400 characters). Catalogs are capped at 2,000 models.
- **Checklist import:** Discovered models appear in a searchable checklist. Models already configured in `models.json` are marked `Added` and cannot be checked. Each row shows the metadata it declared, e.g. `deepseek-flash · DeepSeek-V4.1-Flash · 1.0M ctx · 393k out · img · think`. Confirming imports the checked models — or just the highlighted one when nothing is checked — with that metadata, saves immediately, and refreshes the provider runtime. `Esc` discards the results.

Imported metadata lands in the same fields the editor already manages, so `contextWindow`, `maxTokens`, `input`, and `reasoning` remain editable afterwards. Cost is never imported: catalog pricing dialects differ in both unit and precision, and a misread rate misreports spend by orders of magnitude.

## Use Built-in Data

The `Use Built-in Data` row in a model's field list provides field-level completion from Pi's built-in model catalog:

- **Matching:** Queries Pi's catalog using exact ID matches first, then normalized ID comparisons, then fuzzy search. Ties prefer entries sharing the model's effective API protocol. Up to 8 candidates are presented.
- **Preview:** Selecting a candidate displays a per-field comparison (`current → reference`). Applying verifies that the model and its effective API still match the preview. Existing cost tiers and unrelated nested compatibility entries are retained.
- **Default selections:** Unset scalar fields (`name`, `reasoning`, `input`, `contextWindow`, `maxTokens`) are pre-checked. Explicitly configured values remain unchecked. `thinkingLevelMap`, `compat`, and `cost` are always opt-in.
- **Safety boundaries:** Cross-API thinking maps and compat dictionaries are view-only and cannot be imported. Cost tiers from the reference are never imported. Identity and connection fields (`provider`, `id`, `api`, `baseUrl`, keys) are never altered. Pressing `Esc` discards the preview without applying changes.

## Persistence and runtime refresh

- **Atomic locking:** Edits save immediately. Writes acquire a cross-process lock via `proper-lockfile`, write to a temporary file in the same directory, validate the candidate file with `ModelConfig`, and atomically rename it into place.
- **Backup:** The first write over an existing file creates a `.bak` copy of its content. Symlinked configuration files are edited at their resolved target without replacing the symlink.
- **Formatting:** Comments and custom indentation are normalized to two-space JSON on save. Unknown top-level and nested values are preserved.
- **Conflict resolution:** Every save re-reads the file under a cross-process lock and applies pending edits onto the freshest content, so unrelated external edits merge automatically and a same-field race resolves last-writer-wins. Edits targeting externally removed models simply miss, and the view resyncs onto the merged result after each save.
- **Runtime refresh:** An offline-scoped refresh (`allowNetwork: false`) synchronizes the runtime when `/provider` closes (or immediately following a Fetch Models import). Save errors and runtime refresh errors are reported independently.
- **Recovery:** Failed edits remain pending and retry automatically with the next save. Closing offers return, retry, or explicit discard. Fetch refreshes retain the changed-model information needed to update the active session model on close. Leaving a pane cancels its outstanding discovery and prevents late results from changing another page.
- **Overlay behavior:** Configuring a provider whose ID matches a Pi built-in provider overlays that catalog. Deleting the provider configuration unmasks the built-in models. Existing `modelOverrides` in `models.json` remain preserved and take precedence over fields edited here.

## Migration from router

The `provider` extension replaces the retired `router` extension.

- Existing `~/.pi/agent/router.json` and `~/.pi/agent/router-client.json` files remain on disk unmigrated for manual reference.
- The previous Codex 0.153.4-pinned relay request profile is discontinued. Requests now follow Pi's native API implementations and standard `models.json` `compat` options.
