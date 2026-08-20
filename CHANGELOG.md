# Changelog

This file records `@astralyn/pi` releases beginning with the first Fork-owned release, `0.81.1-1`. Earlier history belongs to upstream Pi and is not maintained here.

## [Unreleased]

## [0.84.7] - 2026-08-21

### Fixed

- Fixed `/agents` flashing the main editor for one frame between nested TUI pages by keeping profile, settings, model, and thinking navigation inside one custom UI lifecycle.
- Fixed `/router` flashing the main editor between nested menus, prompts, confirmations, catalog loading, and model selection by keeping its complete TUI flow inside one custom UI lifecycle.
- Fixed an uncaught TUI crash when the Background tool received an incomplete streaming argument frame by keeping its call renderer valid until the action and create command are available.

## [0.84.6] - 2026-08-15

### Added

- Added `wait` and `list` actions to the bundled Background extension's new single `bg` tool: `wait` blocks (bounded, default 20s / max 60s) for a task's completion and delivers it inline with the output delta since a given byte offset — the followUp notification is suppressed so the completion is delivered exactly once — and `list` enumerates known tasks (running first, five most recent finished) for the model.
- Added an optional `description` label to Background task creation, shown in `/bg`, task listings, and the completion notification.
- Added a stall watchdog to the bundled Background extension (Claude Code CC-1175 design): a task whose output stops growing for 45s with a prompt-looking tail (`(y/n)`, `Press Enter`, …) is flagged `waiting for input`, sends a one-shot notification with remediation advice (kill and re-run with piped input or a non-interactive flag), marks the task in `/bg` and the footer statusline, and never fires twice or on merely-slow tasks.
- Background task output files are now created exclusively (`wx`), so creation can never truncate an existing file or a symlink target.
- Added a live pending line to the bundled Background extension's `bg wait` transcript row: while the wait is open it refreshes once per second with elapsed/wait-window and the new-output delta since the wait began (e.g. `bg wait bg-3f · waiting 12s/20s · +3.2KB new output`), then settles with the result row.
- Added single-line scrolling (`↑`/`↓`) to the `/bg` output view alongside paging, and a `── finished ──` separator between running and finished tasks in the `/bg` list.

### Changed

- Merged the bundled Background extension's `bg_bash`, `bg_logs`, and `bg_kill` tools into one `bg` tool with an `action` parameter (`create`/`read`/`wait`/`kill`/`list`), rewrote the model-facing copy around the full task lifecycle (including the do-not-append-`&` and never-sleep-poll rules), and made every task's output readable with the built-in read tool via its plain output file.
- Added optional `ctx.getShellSettings()` for extensions, exposing the session's `shellPath` and `shellCommandPrefix` exactly as the built-in bash tool uses them (older hosts without it fall back to disk settings); the `ShellSettings` type is exported from the package root.
- The `/bg` task list now adapts its visible rows to short terminal windows (down from 10), and the output view only re-reads a task's output file when its byte count actually changed — finished tasks are read once; fully-settled menus stop redrawing entirely.
- A collapsed Background completion notification now shows the output file's name instead of its full path (the full path and tail remain available when expanded).
- The Background footer segment now reports stalled tasks separately (`bg 2 running · 1 waiting for input · 2 done`), so the counts add up.
- `/bg` kill feedback now reads `stopping <id>…` and expires once the task settles; any keypress also clears it.
- Restructured the bundled Subagent extension internals into a pure per-run state machine with dedicated cancellation scopes, a loop-free two-pass details budget, and shared model-selection and choice helpers for `/agents`; the tool schema, `subagent.json` format, `/agents` interaction contract, and public result shapes are unchanged.

### Fixed

- Fixed the bundled Subagent extension missing tasks that were still queued at the concurrency gate during session shutdown (a queued task could start after the shutdown snapshot and keep running), worker runs not settling when aborted while worker resources were still loading, the live activity line clearing while parallel tools were still running, and progress updates being swallowed when only usage cost or the context watermark changed.
- Fixed the bundled Background extension building its shell configuration from disk instead of the current session's settings, which could diverge from the built-in bash tool on SDK hosts using a custom agent directory or in-memory settings, and rejecting over-limit `bg_bash` timeouts synchronously instead of failing the started task asynchronously.
- Fixed Background completion notifications embedding XML-illegal characters (lone surrogates, U+FFFE/U+FFFF, control characters) by filtering all notification fields through a dedicated XML 1.0 character filter, and the `/bg` output view no longer renders an empty resume hint when `pageDown` is unbound.

## [0.84.5] - 2026-08-14

### Added

- Added `ExtensionContext.modelRuntime`, exposing the parent session's canonical model/authentication runtime for nested SDK sessions without provider or credential mirroring.
- Added the bundled Background extension: `bg_bash` runs shell commands in the background with automatic completion notifications (queued while streaming, waking the agent when idle), `bg_logs` reads bounded output slices, and `bg_kill` stops a single task. `/bg` opens an inline task menu (like `/model`) with an Enter-to-open live output view, and running counts surface in the footer as `bg N running · M done`. Background tasks inherit the session's `PI_*` variables like the built-in bash tool.
- Added inherited fullscreen transcript search with `Ctrl+Shift+F`, configurable search-match theme colors, next/previous navigation, host-clipboard selection copy, and unbound single-line transcript scrolling actions.
- Added `defaultTools` for selecting startup built-ins, `fullscreenExitOutput` for choosing transcript or resume-hint output, and `--use-theme <name[/name]>` for a per-run initial theme.
- Added experimental strict JSON-schema constrained sampling for the default `read`, `bash`, `edit`, and `write` tools under `PI_EXPERIMENTAL=1`, plus `expandPromptTemplates` for extension `pi.sendUserMessage()` calls.
- Added inherited `createGatewayBindingFetch()` for tokenless Cloudflare AI Gateway bindings, `AssistantMessage.endTurn`, tool-call namespaces, and OpenAI Responses `additional_tools` compatibility.

### Changed

- Followed upstream Pi `v0.84.2`, updating the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@earendil-works/pi-client`, and `@earendil-works/pi-protocol` runtime dependencies to `0.84.2`.
- Replaced the inherited Mistral SDK transport with a native Chat Completions HTTP stream, changed inherited Kimi Coding requests to use Pi's runtime user agent, and enabled message-anchored OpenAI Responses `additional_tools` where supported.
- Redesigned the bundled Subagent around one required `tasks` array: one item launches one worker and multiple items run concurrently through the session-wide five-worker gate, with Explorer as the default and results kept in input order. Calls now preflight the whole batch before launch, task-retry backoff releases its concurrency slot, and partial batches have an explicit aggregate status.
- Reduced Subagent profiles to the two built-ins, Explorer and General. Explorer retains prompt-constrained read-only Bash for Git inspection; `/agents` now configures only these profiles and saves each model, thinking, or inherit selection immediately without a draft or Apply step.
- Simplified the Subagent transcript: running collapsed cards show a progress header plus one row per task, settled collapsed cards show the aggregate outcome plus one status row per task, and settled expanded cards show each original Prompt and final Report. Streaming assistant tails and inferred activity phases were removed.
- Stale or invalid `subagent.json` files (pre-redesign formats, unknown profiles, malformed JSON) are reset to an empty inheriting config on load instead of failing the tool call or `/agents`.

### Fixed

- Fixed managed `fd`/`rg` downloads blocking TUI startup with hidden diagnostics, and fixed concurrent startup/model-selector catalog refreshes cancelling and restarting one another.
- Fixed JSON and RPC `message_update` events dropping cumulative usage, `pi.sendMessage(..., { triggerTurn: false })` steering an active run instead of only recording its message, and custom system prompts concatenating the working-directory line with later prompt content.
- Fixed inherited provider behavior across GitHub Copilot, DeepSeek, Amazon Bedrock, Google Generative AI, Vertex AI, and OpenAI Responses, plus fullscreen search, mouse selection/link activation, overlay scrolling, split `Alt+Enter`, idle repainting, and LaTeX parsing.

### Breaking Changes

- Removed the Subagent single/parallel parameter modes, caller-supplied task descriptions, dynamic user/project profile files, and compatibility parsing for old tool or configuration shapes. The tool now accepts only `{ tasks: [{ prompt, agent?, cwd? }] }`, and `subagent.json` accepts only `explorer` and `general` profile keys.

## [0.84.4] - 2026-08-11

### Added

- Added `npm run diff:upstream -- --target v<version>`, which classifies an upstream release diff against the deviation ledger for synchronization triage: changes touching registered deviations, adoption candidates the fork has not touched, and removed upstream paths.

### Changed

- Redesigned the bundled Subagent `/agents` command around an alphabetized, title-cased profile picker and a unified model-search/thinking editor; model and thinking changes now commit together, while lowercase profile identifiers and inheritance semantics remain unchanged.
- Slimmed the deviation ledger schema to category, intent, and optional covering tests, dropping the constant verification-status field. The `diff:upstream` report now folds directory-registered paths into single annotated lines, and `maintainers/upstream.md` documents what each category means and how to treat it during synchronization.
- Reworked the bundled Todo UI into a width-responsive one-line widget that shows subjects only, hides when no unfinished work remains, and leaves full subject-and-description output to `/todos`; completion timers and visibility caches were removed.

### Fixed

- Fixed `/agents` placing model-facing Profile guidance in the dialog title; concise human-facing descriptions now render in full and wrap below the selected Profile.

### Breaking Changes

- Replaced the bundled Todo tool with a smaller v2 protocol: `create` now accepts one ordered `items` array for both single and batch creation, while only `update`, `list`, and batch-ID `delete` remain. Dependencies, active-form/owner/metadata fields, tombstones, filtering, pagination, `get`, and `clear` were removed; subjects and descriptions can no longer be cleared to empty strings, and current lists are capped at 20 tasks. Tool-result `details` now use `{ schemaVersion, change, state }`; historical v1 snapshots are intentionally not restored.

### Removed

- Removed the unused `SelectOption` object form from the Extension API select dialog; `ui.select()` takes plain string options again. The bundled extensions already render rich choices through their own dialogs, and the startup, RPC, and selector paths return to upstream behavior.

## [0.84.3] - 2026-08-10

### Added

- Added `maintainers/deltas.json`, a per-path deviation ledger covering every modified or dropped upstream file with category, intent, covering tests, and verification status. `npm run diff:upstream` annotates its report from the ledger and `--check` now fails on unregistered deviations and stale entries.

### Changed

- Changed the default interactive TUI mode from `regular` to `fullscreen`. The regular inline mode remains available through `tuiMode` in settings or `--tui-mode regular`.
- Extracted automatic compaction (mid-turn, post-run, and pre-prompt threshold checks, overflow compact-and-retry recovery, and the fail-closed stop) from `AgentSession` into a dedicated `CompactionController`. Behavior is unchanged; manual `/compact` stays in `AgentSession`.
- Centralized distribution deltas behind `config.ts` constants: the `@astralyn/pi` package name (extension loader aliases and the first-time-setup guard), the disabled upstream install-telemetry endpoint, and the update-notification changelog hint. The internal telemetry helper regains its upstream name; the provider-attribution behavior and settings UI wording are unchanged.

### Removed

- Removed the coalescing terminal render patch (atomic write batching for IME stability and scrollback preservation across content-driven full redraws). Fullscreen mode renders in the alternate screen and does not need it; regular mode returns to upstream rendering behavior, including IME candidate-window movement and scroll-to-bottom on full redraws.
- Removed the `rendersOwnProgress` and `renderRefreshIntervalMs` tool definition fields and the `cancelHint`/`subtitle` select dialog options from the Extension API. The generic `Running… (Ns)` row now only covers bash; time-driven tool renderers self-schedule repaints through `context.state` timers and `context.invalidate()`, and the bundled DeepWiki tool shows its own query elapsed time.

## [0.84.2] - 2026-08-09

### Removed

- Removed the bundled rewind extension, including per-edit backups, the `/rewind` settings command, and `/tree` work-tree restoration. Existing `~/.pi/agent/rewind/` data is no longer read and can be removed manually; historical `pi-rewind-snapshot` session entries remain inert.
- Removed the bundled Biu extension, including the `/biu` workflow command, `biu://` path resolution for the core file tools, and the SPEC approval gate. Existing `~/.pi/agent/biu/` workspace data is no longer read and can be removed manually; historical `biu-mode` session entries stay inert and `biu-kickoff` messages fall back to the default custom-message rendering.

## [0.84.1] - 2026-08-07

### Added

- Added `pi auth check` for provider/model credential preflight with optional JSON output and credential emission; the existing `pi auth print-api-key` and `pi auth print-bearer-token` commands now share the unified `pi auth` parser while keeping case-insensitive `--min-expiry` duration units.
- Added inherited Qwen Token Plan Individual as a built-in provider with its documented subscription model catalog and the shared international `QWEN_TOKEN_PLAN_API_KEY`.
- Added `terminate` support to blocked extension `tool_call` events so all-terminating batches can skip the automatic follow-up model call.
- Added the inherited coding-agent harness factory (`src/server/create-harness.ts`) composing built-in tool prompt contributions for server-side embedding.
- Added inherited fullscreen double-click word, triple-click paragraph, and granularity-aware drag selection, unbound half-page transcript scrolling actions, and right-click clipboard paste on Windows.

### Changed

- Followed upstream Pi `v0.84.1`, updating the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@earendil-works/pi-client`, and `@earendil-works/pi-protocol` runtime dependencies to `0.84.1`.
- Changed the scrollback-preservation window to live entirely in the coalescing terminal: the viewport top is read through pi-tui's public `captureRenderState()` instead of a private field, and the user-input half of the window is observed on the shared terminal's input path instead of per-renderer TUI listeners.
- Softened the inherited bash tool's `PI_*` environment guideline to reduce unnecessary inspection commands, and reduced worst-case automatic terminal theme detection delay from 200 ms to 100 ms.

### Fixed

- Fixed inherited extension TUI method wrappers recursing indefinitely when delegating to the original method.
- Fixed inherited `Agent.reset()` clearing transcript and runtime state during active runs; it now rejects until the agent is idle.
- Fixed inherited LaTeX relation, multiplication, and named-operator spacing, matrix composition with stacked fractions, operator limits, and adjacent matrices, and reduced fullscreen mouse event volume under tmux, Zellij, and GNU Screen.

## [0.84.0] - 2026-08-07

### Added

- Added inherited fullscreen TUI mode with a sticky editor/footer, independently scrollable transcript, runtime mode switching, draggable configurable scrollbars, stacked notifications, fullscreen navigation bindings, and opt-in `Ctrl+P`/`Ctrl+N` prompt-history navigation.
- Added inherited Mermaid diagrams and terminal-friendly Unicode LaTeX rendering for interactive Markdown, plus chainable display-only `pi.registerMarkdownTransformer()` extension hooks.
- Added per-directory `AGENTS.override.md` context files, arbitrary OpenAI-compatible `samplingParams`, opt-in vLLM thinking-token budgets, finish-reason inference for compatible streams, and built-in Baseten provider support.
- Added experimental remote-session APIs through the new `@astralyn/pi/client` export, backed by the exact `@earendil-works/pi-client` and `@earendil-works/pi-protocol` dependencies, plus `CredentialSynchronizationError` for committed credential changes whose local model-state synchronization fails.
- Added the bundled TUI-only Biu extension: `/biu` toggles a simple development workflow (plan → optional decompose → execute → archive) whose state lives in the frontmatter of private workspace Markdown files addressed through the `biu://` scheme; inside the mode, `/biu` opens a compact menu with continue, deterministic archiving, and exit. Each turn injects the stage playbook together with a read-only workspace snapshot.
- Added a user approval gate for the Biu SPEC: marking `biu://SPEC.md` as `ready` opens a confirmation dialog, and declining blocks the write and returns the feedback to the model as the tool result, mirroring Plan Mode's approve/reject loop.
- Added the `execution: direct|tasks` frontmatter field to the Biu SPEC: the plan stage records the agreed execution path before approval, and the execute stage loads a single-purpose playbook (direct implementation, decomposition, or an undecided fallback for older SPECs) instead of re-asking how to proceed.

### Changed

- Followed upstream Pi `v0.84.0`, updating the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` runtime dependencies to `0.84.0`; added exact `@earendil-works/pi-client` and `@earendil-works/pi-protocol` `0.84.0` dependencies, Mermaid rendering, and Undici 8.9.0.
- Changed tool call chrome so multi-line call previews continue the dim `│` rail from the status dot: args, blank lines, and the result now read as one connected block instead of an indented island above a lone rail.

### Breaking Changes

- Changed JSON and RPC `message_update` events to carry only `assistantMessageEvent` deltas. The cumulative `message` and `assistantMessageEvent.partial` fields were removed; clients must assemble deltas between `message_start` and the authoritative `message_end`.
- Renamed the inherited pi-ai `ModelsStreamTransforms` interface to `ModelsRequestTransforms`, reflecting that header transforms apply to all authenticated provider requests.
- Changed model/provider extension contracts: `ModelRegistry.refresh()` now accepts `ModelsRefreshOptions` and returns `ModelsRefreshResult`; returned provider headers preserve `null` deletion markers; `ModelRuntime.setRuntimeApiKey()` accepts auth cancellation options; OAuth `refreshToken` receives an `AbortSignal`; and native provider refreshes publish through `context.stored` and generation-checked `context.publish()`.
- Adopted pi-agent-core's v4 lane-based session APIs and promoted v2 `AgentHarness` APIs to the default export, replacing the inherited legacy experimental and repository contracts.

### Fixed

- Fixed credential and catalog concurrency stalls: OAuth refreshes release storage locks, forced availability refreshes can bypass stalled passes, concurrent stores avoid lock convoys and lost updates, and login, `/model`, and `/scoped-models` use cached state without waiting indefinitely for remote catalogs.
- Fixed Windows file-tool paths from Git Bash, MSYS, Cygwin, and WSL, path-containing `find` globs, and root-level `find` result relativization.
- Fixed manual and automatic compaction races, queued prompts during `/compact`, truncated responses that should compact and retry, and credential-resolved GitHub Copilot endpoints in compaction and extension model calls.
- Fixed oversized tool-result images bypassing resizing, malformed package manifests crashing startup, symlinked session discovery, Git package dependency recovery, and transient management HTTP requests lacking bounded retries.
- Fixed fullscreen terminal shutdown, image rendering and transcript performance, copy feedback, settings search input, editor navigation, and custom-editor autocomplete limits.
- Fixed inherited provider and transport behavior across Anthropic, Google, OpenAI Codex, GitHub Copilot, Fireworks, Groq, Bedrock, and OpenAI-compatible gateways, plus terminal width, color, image, mouse, and Windows keyboard handling.
- Updated Undici to 8.9.0 and pinned `brace-expansion` 5.0.9 to address their published security advisories, including GHSA-rgw5-rvv9-x895.
- Fixed extension confirm dialogs folding the message into the accent-bold title; the message now renders as a muted subtitle under the title.
- Fixed Router allowing the active session model or its relay to be disabled or removed, leaving stale model state; catalog selection now keeps the current model selected and removal asks the user to switch models first.
- Fixed partial Router thinking maps omitting `xhigh` and `max` at runtime while the UI reported them enabled; omitted levels now inherit the five-level GPT Gateway defaults while explicit `null` choices remain hidden.
- Fixed Biu archiving leaving the cycle half-moved when a file move failed mid-archive: already-moved files now roll back, and an incomplete rollback reports where the recovery data is instead of failing silently.
- Fixed Biu archive rollback failing on Windows when the state write failed after all files were moved: the fresh empty tasks/ directory no longer blocks the move-back, because it is recreated only after the state reset succeeds.
- Fixed Biu refusing to lose leftover cycle files: when biu.json is missing but SPEC.md or task files are still present, a fresh workspace is no longer created over them.
- Fixed Biu accepting hand-edited `biu.json` files with dependency cycles or self-dependencies, and new tasks accepting non-ready initial statuses despite the ready-by-default contract.
- Fixed the Biu task id schema permitting longer ids than the `TASK-` plus 1-80 format, and Biu Mode in a directory without a cycle now starts a fresh workspace instead of reporting a state error.
- Fixed Biu tool calls failing through API adapters that materialize optional flat-schema fields: arguments are now projected to the selected action, and task creation tolerates a semantically neutral required `status: "ready"` while still rejecting other initial statuses.
- Fixed Biu opening a blocking, information-poor selector in RPC mode; the workflow is now explicitly interactive-TUI-only and stays inactive without overwriting the branch flag in RPC, JSON, and print sessions.

## [0.83.0] - 2026-07-30

### Added

- Added `pi auth print-api-key` and `pi auth print-bearer-token` for exporting a model provider's configured credential to external clients; OAuth bearer tokens refresh through the normal auth path and support a configurable minimum remaining lifetime.
- Exposed the active session's read-only scoped model list as `ctx.scopedModels` for extensions.
- Added inherited per-request `fetch` injection for supported text and image provider transports, plus the inherited `"pending"` stop reason for partial streaming messages and raw provider stop reasons across Anthropic, Amazon Bedrock, Google, Mistral, and OpenAI adapters.
- Added inherited manual redirect URL and authorization-code entry to OpenRouter login for remote and headless environments, and Claude Opus 5 support through GitHub Copilot with adaptive thinking and a 1M context window.

### Changed

- Followed upstream Pi `v0.83.0`, updating the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` runtime dependencies to `0.83.0` and TypeBox to `1.3.7`.
- TypeBox 1.3.7 removes deprecated APIs including `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, and `Value.Mutate`; extensions using them must migrate to supported APIs.
- Changed inherited OAuth resolution to refresh tokens with less than five minutes of validity remaining instead of waiting until expiration.
- Consolidated maintainer and public documentation, streamlined package link and navigation validation (`scripts/check-docs.mjs`), and simplified upstream synchronization around a recorded baseline manifest (`maintainers/upstream.json`) and worktree classifier (`scripts/diff-upstream.mjs`).

### Fixed

- Fixed startup resource listings omitting file-backed system prompts, duplicate project context in nested Git worktrees (including drive-letter case differences on Windows), and extension resource reloads losing package provenance metadata.
- Fixed concurrent user Bash cancellation, RPC Bash bypassing `user_bash` extension handlers, active responses surviving session replacement or committed tree navigation, and duplicate interactive subscriptions during startup session switches.
- Fixed filtered model selection retaining a stale row, failed Git installs leaving partial checkouts, llama.cpp streaming usage remaining disabled, and uppercase credential-expiry units being interpreted incorrectly.
- Fixed inherited Qwen Token Plan reasoning controls, Z.AI output-limit parameters, configured Amazon Bedrock profile precedence, narrow-terminal image fallbacks, and OpenAI-compatible function arguments accompanied by empty custom payloads.
- Fixed quoted external-editor commands whose executable or arguments contain spaces, path-segment `find` globs on Windows, and project trust misclassifying operating-system home skills when `HOME` points elsewhere or losing decisions when Windows path casing changes.

### Removed

- Removed the existing bundled Plan Mode implementation, its legacy extension example, tests, and user documentation ahead of a replacement design.

## [0.82.7] - 2026-07-28

### Added

- Added shell-wide delayed progress for native tool calls: default-shell tools still running after two seconds show a live `Running… (Ns)` row, while tools with purpose-built progress UI can opt out.
- Added `renderRefreshIntervalMs` for extension tools that need their call/result renderers rebuilt while a result is partial. It is independent of `rendersOwnProgress`, which only suppresses the generic `Running…` row, and refresh is bounded and lifecycle-safe.

### Changed

- Reworked native tool presentation so the dim `│` rail continues through every result line, empty lines retain the rail, collapsed-line hints share one counted and keybinding-aware format, and `grep`/`ls` join `read`/`find` in the collapsed `explore` group. Built-in calls now use consistent path links, flags, limits, and honest truncation; Bash reports hidden command lines, and `edit` shows Diff statistics with a bounded ten-line collapsed preview.
- Improved bundled tool transcripts: Todo batch calls preview subjects and expand every bounded item; Subagent failures use separate wrapped reason lines with sentence-aware excerpts and consistent expanded sections; Question calls reveal full prompts on expand and preserve partial cancelled/clarification answers; Plan calls render expanded Markdown with clearer decision hierarchy; and DeepWiki uses normalized, subdued one-line summaries with an inline expand hint.
- Reworked plan mode into read-only exploration: it now activates `grep`/`find`/`ls`, permits only the read-only `explorer` subagent profile, and keeps Bash available under a prompt-enforced (not sandboxed) read-only contract; `edit` and `write` remain disabled.
- Plan files now live per project under `<agentDir>/plans/<project>/` with timestamped names; `/plan` opens a TUI panel to exit or paste a saved plan path, while existing legacy plan paths remain usable.
- Compact-then-execute plan kickoffs now appear as a collapsed plan card showing the title and saved path; expand it to view the full kickoff Markdown.
- Standardized compact interactive key hints on the first configured binding with readable special-key labels and `key action • key action` phrasing in the extension selector and Question dialogs.
- Documentation checks now validate same-page and cross-page Markdown fragments, and upstream delta checks reject stale distribution-owned registrations.

### Fixed

- Fixed the router replaying relay-supplied generic `item_*` IDs into later stateless requests, where strict Codex gateways reject a reasoning item unless its ID begins with `rs_`. The relay now omits recognized ResponseItem variants' optional top-level identity IDs while retaining required semantic reference IDs, `call_id`, and encrypted reasoning content, matching Codex CLI 0.145's default non-Azure `store: false` request behavior.
- Fixed nested foreground/background theme styling losing the outer color after an inner reset, and fixed manual `!!` command headers losing their dim border color after the first output update.
- Fixed Todo batch headlines saying `1 tasks`, fixed shell-wide and Subagent duration rollover from showing raw 60–89 second values or impossible `1m 60s` timestamps, and stopped collapsed Question schema errors from dumping the full validator report and received arguments.
- Fixed silent Subagent elapsed clocks and retry countdowns freezing between progress updates. Single and parallel cards now refresh once per second without a duplicate generic progress row; provider/task retry countdowns share bounded deadline metadata, show `Retrying now…` at zero, and abort cleanly during backoff or SDK initialization.
- Fixed other time-driven TUI lifecycle defects: deadline-based dialog countdowns no longer drift across event-loop stalls or sleep; `/resume` relative ages refresh while open; `/tree` label timestamps reclassify at local midnight; Armin rain no longer redraws forever on empty columns; and selector/animation timers are disposed on close, replacement, chat rebuild, or shutdown.
- Corrected bundled-extension inventories and usage guidance to reflect the shipped plan, subagent, and todo workflows; repaired the RPC type link and clarified that activating `bash` is not a read-only tool configuration.
- Updated the packaged `brace-expansion` dependency to 5.0.8 to address GHSA-mh99-v99m-4gvg.

## [0.82.6] - 2026-07-27

### Added

- The bundled `todo` tool now supports atomic `create_many` planning batches (up to 20 tasks) with stable batch keys and intra-batch dependencies, paged/searchable/unblocked `list` queries, and bounded nested JSON metadata. Task snapshots are schema-versioned and defensively replayed, so malformed latest history falls back to the last valid snapshot. `clear` now requires `confirm: true` plus the current `expectedCount`; an active task that gains an unresolved dependency automatically returns to `pending`.

- Select dialogs can now carry a second layer of information: `ctx.ui.select()` accepts `{ label, description }` options, rendering the description as a muted line under the label so the action and its trade-off can be scanned separately, and takes `subtitle` (a muted line under the title, for context that is not itself a choice) and `cancelHint` (wording for the dismiss hint, for dialogs where `Esc` is not destructive). Plain `string[]` options still work, and `select()` still resolves to the chosen label. RPC clients receive labels only, so the wire protocol is unchanged. See [extensions](docs/extensions.md).

### Changed

- Returned bash output decoding to the reviewed upstream UTF-8-only streaming `TextDecoder`, removing the distribution-specific OEM-code-page fallback and per-line buffering. Legacy Windows console programs that emit non-UTF-8 bytes now follow upstream behavior and may render replacement characters.

- Collapsed `todo` groups now summarize completed operations — created IDs, status updates, list counts, deletion, and clearing — instead of hiding their results; failed rows include a sanitized 120-character reason, and `ctrl+o` still reveals full calls and results. See [todo](docs/bundled/extensions/todo.md).

- Redesigned the `exit_plan` approval dialog and tool row. The three choices now separate the decision from its trade-off (`Start executing` / *keep full context*) instead of burying it in a parenthetical, the dialog subtitle reports current context usage — the fact the compact-or-not decision actually turns on — and the dismiss hint reads "keep planning" rather than "cancel", matching what `Esc` has always done. The tool row no longer echoes the plan: a collapsed call shows `exit_plan <title>` (plan body on `ctrl+o`) instead of the whole markdown document escaped onto one line, and the result shows where the plan landed plus what happens next, instead of the mode-precedence text written for the model.
- The plan-mode footer marker now reads `Plan Mode` in the theme's accent color rather than a `plan` tag in warning yellow — plan mode is a working mode, not a warning state.
- Consecutive `todo` calls now collapse into one grouped run like `read`/`find`'s `explore` group, and each call renders as a single headline (`todo create <subject>`, `todo update #2 in_progress`) instead of a raw argument dump. `ctrl+o` expands the group back to full calls, where the headline is followed by the parameters the result never echoes (`description`, `activeForm`, dependency edges). See [tool presentation](docs/bundled/tool-presentation.md).
- Redesigned the subagent transcript around a deep-trimmed collapsed card and a report-cover-sheet expanded view. Collapsed: a running single delegation folds to at most three lines — the intent line now carries tool uses, the `ctx:` watermark, cost, and elapsed time — and a settled card ends with one `tok · tool uses · ctx · $ · duration` metrics line; parallel batches drop the cross-run activity digest, gain stable dim ordinals on run rows (matching the expanded section numbers, immune to active-first reordering), and settle to a `tok · $ · duration` footer. Live lines never quote token totals, which are cache-inflated mid-run. Expanded (`ctrl+o`): each run renders a status line (`✓ Completed · model · thinking`), a metrics line, a fixed two-line `Prompt` preview with honest continuation notes (`… continues, N more lines · capped at 1KB`), an `Activity · last n of N` digest whose successful rows are quiet one-liners (glyphs only for failures and the in-flight row, durations only at ten seconds or longer), a `Working` tail of the last three live lines while streaming, and the full `Report` (or `Error`, with `Report · partial` for salvaged output) rendered as Markdown — replacing the full prompt echo, the glyphed activity dump, and the trailing metadata line. See [subagent](docs/bundled/extensions/subagent.md).
- The subagent tool now accepts an absolute task `cwd` that stays inside the parent working directory — models routinely echo the parent cwd back verbatim — instead of failing the task over path style; escapes are still rejected.

### Fixed

- Fixed the `router` relay rejecting multi-turn GPT conversations on Codex-adapted gateways with `input[i].status: unknown_parameter`. pi-ai replays history per the OpenAI Platform schema — assistant messages carry a hardcoded `status: "completed"`, reasoning items are replayed verbatim from `output_item.done` (which includes `status`), and `output_text` blocks carry `annotations: []` — but Codex CLI's `ResponseItem` serialization emits none of these, so gateways that validate against the Codex schema 400. The relay payload reshape now strips `status` from exactly the item types whose Codex serialization has no such field (`message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call_output` — it is required on `local_shell_call`/`tool_search_output` and optional elsewhere, so those keep it), drops `annotations` from `output_text` content, and deletes the pi-specific `prompt_cache_options` request field alongside the other Platform-only fields.
- Fixed the subagent live tail freezing into a lone `…` once a worker streamed more than 1KB of text: bounded details now keep the newest `liveText` via tail-bounding instead of head-bounding, and the renderer skips truncation-notice lines outright, in both the collapsed tail line and the expanded `Working` section.
- Fixed the expanded parallel batch trailer quoting the cache-inflated aggregate token total while runs were still in flight; the trailer now omits `tok` until the batch settles, matching every other live line.
- Fixed the subagent card sitting empty while first-use model-runtime creation or task resolution stalled: the tool now paints `Initializing…` before its first await.
- Transcript excerpt scrubbing now also covers `boundText`'s minimal `[Output truncated.]` notice, and a worker running with `thinking: off` no longer renders a bare `off` segment in expanded batch metrics.

## [0.82.5] - 2026-07-26

### Added

- Added digit quick-select to the `question` tool dialog: pressing `1`–`9` jumps to the numbered option — selecting it in single-select, toggling it in multi-select — and the custom-answer row's number opens its input. See [question](docs/bundled/extensions/question.md).
- Added reverse dependency edges to the `todo` tool: `addBlocks`/`removeBlocks` on `update` let one call mark the tasks that must wait for the current one, with the same existence, tombstone, and cycle validation as `addBlockedBy`. See [todo](docs/bundled/extensions/todo.md).

### Changed

- Gave the built-in `explorer` subagent profile read-only shell access: `bash` joins its toolset for inspection commands (`git log`/`blame`/`diff`, `wc`, `head`), with the system prompt pinning it to read-only use — no redirect (`>`, `>>`) or heredoc writes, no temp files, no git commands that write (add, commit, checkout, restore, stash, clean), no installs, no network. Explorer also skips loading `AGENTS.md`/`CLAUDE.md` project instructions, which read-only exploration doesn't need — the parent interprets its results. See [subagent](docs/bundled/extensions/subagent.md).
- Rewrote the subagent tool's model-facing guidance. The description now leads with why to delegate — keeping intermediate tool output (file dumps, search results) out of the parent's context — states explicitly that reports are not shown to the user and must be relayed, names the task and concurrency limits (8 per call, 5 concurrent), advises direct tools for directed lookups and delegation for investigations that would clearly take more than ~3 searches, distinguishes lookup briefings (hand over the exact command) from investigation briefings (hand over the question), suggests bounding answer length, and carries an example explorer briefing. The `general` profile description now states when to choose it over `explorer`, workers are told only their final message is returned and to quote code only when the exact text is load-bearing, and the briefing `prompt` limit rose from 20,000 to 50,000 characters to leave room for pasted context. See [subagent](docs/bundled/extensions/subagent.md).
- Tightened `question` tool validation: option previews on multi-select questions are now rejected with an explicit `preview_multiselect` error instead of being silently dropped, reserved-label and duplicate checks compare case-insensitively and ignore surrounding whitespace, the unused `Next` label is no longer reserved, and length/count checks that duplicated the JSON schema (already enforced before the tool executes) were removed. Preview markdown rendering is also memoized, so editor keystrokes no longer re-parse previews.
- Tightened `todo` tool validation and model-facing output: parameters that do not apply to the chosen action are rejected with guidance instead of being silently ignored (`blockedBy` on `update` now points at `addBlockedBy`/`removeBlockedBy`), `create` requires a `description` stating what done means, id parameters must be positive integers at the schema level, an empty string clears `description`/`activeForm`/`owner`, a deletion cannot be combined with other edits and reports which pending dependents became fully unblocked, `list` lines show only unresolved blockers plus the task's owner, and the truncation notice no longer suggests a status filter that is already applied. The tool description was restructured into sectioned guidance (when to use, status workflow, examples) with explicit blocked-task handling: create a task for the blocker and link it with `addBlockedBy` instead of faking completion. See [todo](docs/bundled/extensions/todo.md).

### Fixed

- Fixed a parallel subagent batch being reported as a failed tool call when only some of its tasks failed. The result is now an error only when no task completed; partial batches surface per-task status in the report sections instead of pushing the parent to retry work that already succeeded.
- Fixed the `todo` extension's stale-context guard being unreachable: lifecycle replay accessed `ctx.sessionManager` before entering its try block, so the error it meant to swallow after a session replacement raced ahead of the guard. The condition is now detected with the new `isStaleExtensionContextError` predicate (exported alongside `STALE_EXTENSION_CONTEXT_MESSAGE` from the extension API) instead of message-text matching.
- Fixed the `question` tool ignoring turn aborts: the dialog now closes when the tool call is cancelled and resolves with the answers given so far, instead of lingering until the next interaction.
- Fixed cancelling the `question` dialog discarding answers already given; the model-facing result now lists them as partial answers, matching the `Chat about this` flow.
- Fixed `question` dialog interaction papercuts: `Tab` on an unselected single-select option no longer silently commits it when the note editor is cancelled (`Esc` restores the previous selection), and Enter on the `Type something.` row of a multi-select question opens the custom-answer input instead of warning that nothing is selected.
- Fixed tool output expanded with `ctrl+o` losing its top lines (for example an expanded subagent card's header, task, and activity sections) when the expansion pushed the transcript past the screen height. The scrollback-preserving full-redraw rewrite introduced in 0.82.4 repainted only the bottom screenful, so lines newly pushed above the viewport were never written anywhere.
- Scoped the 0.82.4 scrollback-preserving redraw rewrite to the window where it matters: from `agent_start` until the user's next input after the run settles, so streaming markdown reflow can no longer yank a scrolled-up reader while text is arriving — including the run's trailing reflow frames. Within that window, redraws that grow the transcript repaint the visible rows in place and scroll the extra lines in at the bottom row, pushing exactly the right rows — already bearing the new content — into scrollback, and explicit toggles (`ctrl+o`/`ctrl+t`) exempt their own frame. Everywhere else — idle sessions, toggles, mode switches — full redraws keep upstream's wipe-and-replay, leaving scrollback as the clean current transcript with no stale seams or per-toggle residue.

## [0.82.4] - 2026-07-26

### Added

- Added a bundled `plan` extension: `/plan` (or `--plan`) enters a read-only planning mode that disables `edit`, `write`, `bash`, and `subagent`, interviews via the `question` tool, and exits through a user-approved `exit_plan` tool call. Approval saves the plan to `<agentDir>/plans/<sessionId>/NN-<slug>.md` and either continues in place or compacts the context first, restarting execution with the plan embedded in the kickoff message.
- Added subagent recovery from transient provider failures: the worker session's auto-retry backoff is now visible in the run status (`Retrying (n/m) in Xs…`), and a failure that produced no turns or tool uses — such as a preflight auth throw, which bypasses session-level retry entirely — is rerun at the task level with exponential backoff. Runs with partial work behind them are never rerun. See [subagent](docs/bundled/extensions/subagent.md).

### Changed

- Reworked the subagent transcript views. Call headers drop the mode wording: a single delegation renders as `General Agent · <description>` with the profile name title-cased for display (`code-reviewer` → `Code Reviewer`), and a batch renders as `Multi-Agent · N tasks`. While running, the collapsed view leads with a tool-derived intent line (`Applying changes`, `Verifying changes`, `Exploring code` — now also covering inspection commands like `git status` and `rg`, `Investigating a failure`) over the raw tool summary, and shows live elapsed time plus a `ctx:` context watermark that tracks the worker's latest request size. Completed excerpts cut at sentence boundaries, and the expanded activity history grows from 4 to 12 entries.
- Retired the subagent renderer's own `●` status dots in favor of the tool shell's call-level dot: `›` now marks the current position (the running task in a batch, the running tool elsewhere), `○`/`✓`/`×`/`■` cover queued and terminal states, and progress headers omit zero counts. Expanded batches gain a numbered contents list matched to `──` section headers, activity rows show durations of a second or longer and color failed result excerpts, the expanded view keeps the streaming tail visible while a run is in flight, and run metadata names the working directory when it differs from the parent's.
- Raised the subagent concurrency gate from three to five workers, and re-headed parallel result sections as `### <description> (<agent>) — <status>` so repeated profile names stay distinguishable.
- Removed the subagent `chain` mode along with `{previous}` substitution: later steps had to be written before earlier results existed, so chains could only hand off blindly. Sequential work is now driven by the parent, which reads each report before writing the next single-mode briefing and can adapt or stop between steps. See [subagent](docs/bundled/extensions/subagent.md).
- Changed mid-turn auto-compaction to distinguish an extension's voluntary `session_before_compact` cancel from a failure: a cancel now lets the run continue (skipping further mid-turn checks for that run) instead of failing closed, and the event carries a new `timing` field (`"manual" | "midTurn" | "postRun" | "prePrompt"`) so extensions can tell the contexts apart. The "nothing to compact" error now includes the same remediation guidance as the retained-context warning. See [Compaction](docs/compaction.md).

### Fixed

- Fixed auto-compaction to also check the context before continuing a run with queued steering or follow-up messages; previously a turn without tool results skipped the mid-turn check and long follow-up chains could only recover via overflow.
- Fixed the IME candidate window jumping between the caret and the end of the input line while typing with a CJK input method in Windows Terminal and other terminals that anchor the candidate window to the hardware cursor. Each TUI render pass is now flushed to stdout as one atomic write instead of separate frame, cursor-reposition, and cursor-visibility writes, so the terminal never observes the intermediate cursor position (upstream [#6289](https://github.com/earendil-works/pi/issues/6289), [#5200](https://github.com/earendil-works/pi/issues/5200)).
- Fixed the terminal viewport jumping to the top of the buffer when scrolling up through history while a response is streaming, most visibly in Windows Terminal. Content-driven full redraws (triggered whenever a line above the viewport changes during streaming markdown reflow) previously cleared the terminal scrollback with `ESC[3J` and replayed the entire transcript; such frames are now rewritten to overwrite the visible screen in place (avoiding `ESC[2J`, which conhost implements by pushing the screen into scrollback), preserving scrollback, the reading position, and pre-session shell history without accumulating duplicate screen copies. Width-change redraws still clear scrollback since re-wrapped content invalidates it (upstream [#6502](https://github.com/earendil-works/pi/issues/6502), [#5576](https://github.com/earendil-works/pi/issues/5576), [#6050](https://github.com/earendil-works/pi/issues/6050)).
- Fixed the rewind extension's `/tree` restore semantics. Snapshots now anchor to the first user entry of a run (steering/follow-up messages no longer shift the anchor onto a mid-run message), and the restore target mirrors `/tree`'s leaf rules: user-message targets restore to the state before that turn, other targets to the state after it, and navigation is silent instead of rolling back the target turn's own edits when nothing was recorded afterwards. Also fixed resume/fork backup migration to link only retained frames (removing a race with over-cap blob pruning), made restore-side change detection immune to mtime-preserving content swaps, deduplicated case-insensitive tracking keys on Windows, and taught the storage menu's "remove all" to keep backups recently written by other running sessions.
- Fixed subagent working-directory resolution under a symlinked parent directory (macOS `/tmp`, Windows junctions): the containment check compared the real parent path against the unresolved candidate, so every call — including the default inherit-cwd case — was rejected as an escape. Traversal and symlink escapes are still blocked.
- Fixed the subagent tool staying broken for the rest of the session after a transient `ModelRuntime` creation failure; the rejected promise is no longer cached, so the next invocation retries.
- Fixed subagent progress updates firing after the tool result had settled (a throttled emitter leaked its timer), and skipped redundant progress serialization when consecutive events change nothing user-visible.

## [0.82.3] - 2026-07-26

### Added

- Exposed the `outputPad` setting to custom message renderers. See [Extensions](docs/extensions.md) ([#7045](https://github.com/earendil-works/pi/pull/7045) by [@xl0](https://github.com/xl0)).

### Changed

- Changed pi.dev model catalog refreshes to revalidate with `If-None-Match`, so unchanged provider catalogs answer with an empty `304` instead of a full download.
- Reworked the package documentation as distribution-owned `@astralyn/pi` user and API guidance, with dedicated bundled-feature pages, standalone examples, complete navigation, and automated checks for broken package links or monorepo-only paths. Repository architecture, upstream synchronization, development, and release procedures now live separately under `maintainers/` and are excluded from npm packages.

### Fixed

- Fixed unavailable scoped models being hidden from `/models`, allowing them to be removed without editing settings manually ([#6949](https://github.com/earendil-works/pi/issues/6949), [#7032](https://github.com/earendil-works/pi/pull/7032) by [@christianklotz](https://github.com/christianklotz)).
- Fixed startup context file discovery to skip directories that match context file names such as `AGENTS.md`, which produced `EISDIR` warnings ([#7106](https://github.com/earendil-works/pi/pull/7106) by [@mrexodia](https://github.com/mrexodia)).
- Fixed the llama.cpp extension to persist its model catalog, so llama.cpp models stay listed before the first successful refresh. See [llama.cpp](docs/llama-cpp.md) ([#7072](https://github.com/earendil-works/pi/pull/7072) by [@davidbrai](https://github.com/davidbrai)).

## [0.82.2] - 2026-07-26

### Fixed

- Fixed auto-compaction during long tool loops: Pi now checks the completed tool batch before the next provider request and continues the same run with rebuilt compacted context when successful. Cancellation, compaction failure, an unavailable cut point, or unsafe retained context now fails closed with an explicit error/aborted boundary before queued-message polling or another provider request.

### Changed

- Converted the source repository to the standalone `@astralyn/pi` package. AI, Agent core, and TUI now resolve from exact upstream npm dependencies, matching the runtime shipped to users without maintaining unrelated source workspaces.

## [0.82.1] - 2026-07-25

### Fixed

- Fixed bash execution to rewrite CMD-style `nul` redirects such as `2>nul` to `/dev/null`, preventing models that emit CMD syntax from creating a literal `nul` file — a reserved Windows name that Explorer cannot delete and that breaks `git add .` and `git clone`.
- Fixed CJK mojibake in bash output from Windows console programs: when output is not valid UTF-8, it is re-decoded with the system OEM code page (GBK, Big5, Shift_JIS, EUC-KR, and others), so cmd.exe builtins, Windows PowerShell — including `-NoProfile` — and classic tools such as `ipconfig` now display correctly.

## [0.82.0] - 2026-07-24

### New Features

- **Constrained tool sampling** — Tools can prefer or require strict JSON Schema sampling or use OpenAI Lark/regex grammars, with model capability metadata preventing unsupported requests.
- **OpenRouter and Kimi Code sign-in** — Use `/login` to authorize OpenRouter or a Kimi Code subscription without manually configuring API keys. See [OpenRouter](docs/providers.md#openrouter).
- **Session-aware, streaming bash integrations** — Bash tools receive current session/model metadata, while direct RPC bash commands stream correlated output. See [Bash Tool Session Environment](docs/environment-variables.md#bash-tool-session-environment) and [RPC bash events](docs/rpc.md#bash_execution_update).

### Added

- Added collapsed tool grouping for consecutive `read`/`find` tool calls.
- Added inherited `Tool.constrainedSampling` with strict JSON Schema (`prefer`/`require`) and OpenAI Lark/regex grammar variants across OpenAI, Anthropic, Amazon Bedrock, Google Gemini, and Mistral.
- Added inherited `supportsGrammarTools` and `supportsStrictTools` compatibility flags, expanded `supportsStrictMode` coverage, and generated model capability metadata to gate constrained sampling.
- Added inherited Kimi Code subscription OAuth login for the Kimi For Coding provider, including device authorization and automatic token refresh ([#6935](https://github.com/earendil-works/pi/pull/6935) by [@zaycruz](https://github.com/zaycruz)).
- Added inherited OpenRouter OAuth PKCE login through `/login`, minting a user-controlled API key. See [OpenRouter](docs/providers.md#openrouter) ([#6927](https://github.com/earendil-works/pi/pull/6927) by [@rsaryev](https://github.com/rsaryev)).
- Exposed `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` to commands run by built-in and factory-created bash tools. See [Bash Tool Session Environment](docs/environment-variables.md#bash-tool-session-environment).
- Added streaming `bash_execution_update` events for direct RPC bash commands, correlated with request IDs. See [RPC bash events](docs/rpc.md#bash_execution_update) ([#6971](https://github.com/earendil-works/pi/pull/6971) by [@ananthakumaran](https://github.com/ananthakumaran)).

### Changed

- Changed Fork versioning to follow upstream minor lines with Fork-owned patch releases and `pi-v<version>` Git tags.
- Subagent delegation now exposes the trusted session agent catalog to the model, provides clearer task briefings and empty-result guidance, and strengthens the built-in general and explorer worker prompts.
- Collapsed Subagent views now summarize activity by tool purpose and show live per-run tool and token progress for parallel work.
- Bash call previews now preserve the raw command instead of summarizing command names; running duration appears after two seconds and is omitted after completion.
- Changed inherited generated model catalogs to expose only provider-verified reasoning effort levels from models.dev ([#6928](https://github.com/earendil-works/pi/pull/6928) by [@davidbrai](https://github.com/davidbrai)).

### Fixed

- Fixed compaction and branch summaries for providers whose authentication resolves entirely to request headers ([#5871](https://github.com/earendil-works/pi/issues/5871)).
- Fixed inherited DNS lookup failures such as `getaddrinfo`, `ENOTFOUND`, and `EAI_AGAIN` to trigger automatic assistant retries ([#6946](https://github.com/earendil-works/pi/pull/6946) by [@christianklotz](https://github.com/christianklotz)).
- Fixed inherited OpenRouter Anthropic cache breakpoints to advance through tool results and enabled cache control for `~anthropic/*-latest` aliases ([#6941](https://github.com/earendil-works/pi/pull/6941) by [@mteam88](https://github.com/mteam88)).
- Fixed inherited OpenAI Codex WebSocket sessions to retry once without a missing previous-response continuation after `previous_response_not_found` errors ([#6955](https://github.com/earendil-works/pi/pull/6955) by [@davidbrai](https://github.com/davidbrai)).
- Fixed TUI debug and crash logs to respect custom agent directories instead of always writing under `~/.pi/agent` ([#6958](https://github.com/earendil-works/pi/pull/6958) by [@davidbrai](https://github.com/davidbrai)).
- Fixed slow Ctrl+G external-editor startup when the system temporary directory contains many entries ([#6903](https://github.com/earendil-works/pi/pull/6903) by [@christianklotz](https://github.com/christianklotz)).
- Fixed startup resource display to preserve relative paths for sibling npm extensions loaded by a package ([#6964](https://github.com/earendil-works/pi/pull/6964) by [@davidbrai](https://github.com/davidbrai)).
- Fixed compaction and branch-summary requests to use fresh routing session IDs with prompt caching disabled where supported ([#6618](https://github.com/earendil-works/pi/pull/6618) by [@tmustier](https://github.com/tmustier)).
- Fixed explicit self-updates when `PI_SKIP_VERSION_CHECK` is set ([#6977](https://github.com/earendil-works/pi/issues/6977)).
- Fixed scoped model IDs containing brackets to resolve as literal exact matches before glob matching ([#6210](https://github.com/earendil-works/pi/issues/6210)).
- Fixed inherited OpenAI and Anthropic provider retry waits to honor abort signals and configured delay limits ([#6980](https://github.com/earendil-works/pi/pull/6980) by [@petrroll](https://github.com/petrroll)).
- Fixed fresh installs from preferring bundled model catalogs over newer remote catalogs because package file mtimes were newer ([#7016](https://github.com/earendil-works/pi/pull/7016) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited editor scroll indicators overflowing narrow terminals ([#7015](https://github.com/earendil-works/pi/pull/7015) by [@christianklotz](https://github.com/christianklotz)).
- Fixed llama.cpp models to use the loaded context window as their output token limit instead of capping it at 16K ([#7034](https://github.com/earendil-works/pi/pull/7034) by [@christianklotz](https://github.com/christianklotz)).
- Updated the packaged `protobufjs` dependency to 7.6.5 to address GHSA-j3f2-48v5-ccww ([#7005](https://github.com/earendil-works/pi/issues/7005)).
- Fixed `/copy` on Wayland to fall back to X11 or OSC 52 when `wl-copy` fails ([#7009](https://github.com/earendil-works/pi/pull/7009) by [@rkfshakti](https://github.com/rkfshakti)).
- Fixed `/model` to reload updated `models.json` configuration when opening the model picker ([#6999](https://github.com/earendil-works/pi/issues/6999)).

## [0.81.1-2] - 2026-07-23

### Changed

- Refined bash tool-call presentation: long safe multi-command chains collapse to a concise command summary, while expanded calls retain the complete command.
- Added Fork repository metadata to the published package for npm provenance validation.

## [0.81.1-1] - 2026-07-22

### Added

- Bundled the `deepwiki`, `question`, `todo`, `rewind`, `router`, and `statusline` extensions as hidden built-ins.
- Bundled the `ice-cream-dark` and `ice-cream-light` themes.

### Changed

- Unified native tool transcript presentation around `●` calls and `│` results, with bounded generic output in collapsed view.
- Published the coding-agent distribution as `@astralyn/pi` with numeric prerelease versions such as `0.81.1-1`.
- Switched version checks and self-update metadata to the npm registry for `@astralyn/pi`.
- Removed install/update telemetry requests to `pi.dev`; the legacy `enableInstallTelemetry` setting now controls only optional provider attribution headers.
- Moved built-in `router` and `rewind` data to `~/.pi/agent/router.json` and `~/.pi/agent/rewind/`; the archived `pi-config` paths are no longer used.
