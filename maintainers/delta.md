# Delta against the reviewed upstream baseline

This file explains why each difference against the reviewed upstream release exists and how to re-verify it during synchronization. The authoritative per-path registry is [`upstream.json`](upstream.json); `npm run diff:upstream` verifies that registry against the actual delta. Update both when a change alters the set of differing files.

Each unit lists its hybrid files (upstream files with local modifications), local files (distribution-owned), the upstream assumptions it depends on, and how to verify it after importing upstream changes.

## 1. Package identity and standalone resolution

The distribution publishes `@astralyn/pi` from a standalone repository instead of the upstream monorepo workspace.

- Hybrid: `package.json`, `npm-shrinkwrap.json`, `tsconfig.build.json`, `tsconfig.examples.json`, `vitest.config.ts`, `.gitignore`, `src/config.ts`, `src/cli/startup-ui.ts`, `src/core/extensions/loader.ts`, `src/utils/version-check.ts`, `scripts/migrate-sessions.sh` (mode bit only)
- Local: `tsconfig.json`, `tsconfig.base.json`, `biome.json`, `.husky/**`, `.npmrc`, `.gitattributes`, `LICENSE`, `.github/**`, `scripts/check-*.mjs`, `scripts/verify-package-install.mjs`, `scripts/diff-upstream.mjs`, `scripts/run-source.mjs`, `scripts/test-isolated.mjs`, `scripts/profile-node.mjs`
- Dropped: `install-lock/**` (upstream lockfile-install fixture; the standalone package uses `npm-shrinkwrap.json` directly)
- Changes: package name fallback and distribution detection use `@astralyn/pi` (`PACKAGE_NAME`, `isPrimaryDistribution()`); the extension loader resolves `pi-ai`/`pi-agent-core`/`pi-tui` through `import.meta.resolve` instead of monorepo workspace probing; the version check queries the npm registry for `PACKAGE_NAME` instead of `pi.dev/api/latest-version`.
- Upstream assumptions: upstream keeps identity constants in `src/config.ts` and workspace resolution localized to `src/core/extensions/loader.ts`.
- Verify: `npm run check`, `npm run verify:package-install`, `test/config.test.ts`, `test/package-command-paths.test.ts`, `test/extensions-discovery.test.ts`, `test/resource-loader.test.ts`, `test/version-check.test.ts`.

## 2. Provider attribution instead of install telemetry

Install reporting to `pi.dev` is removed entirely; the former telemetry switch now only controls optional provider attribution headers.

- Hybrid: `src/core/telemetry.ts`, `src/core/provider-attribution.ts`, `src/core/settings-manager.ts`, `src/modes/interactive/components/settings-selector.ts`, `src/modes/interactive/interactive-mode.ts` (removal of `reportInstallTelemetry()` and its call sites; changelog notice links replaced with `/changelog`)
- Changes: `isInstallTelemetryEnabled` is renamed to `isProviderAttributionEnabled`; the `enableInstallTelemetry` settings key is retained for compatibility but documented and labeled as "Provider attribution".
- Upstream assumptions: upstream funnels install reporting through a single `reportInstallTelemetry()` helper invoked from first-run and update notification paths in `interactive-mode.ts`.
- Verify: settings selector shows "Provider attribution"; no request to `pi.dev/api/report-install` on first run or update notice.

## 3. Windows bash correctness

Two fixes for models and tools running through bash on Windows.

- Hybrid: `src/utils/shell.ts`, `src/core/tools/bash.ts` (spawn path), `src/core/bash-executor.ts`, `src/core/tools/output-accumulator.ts`, `test/resource-loader.test.ts` (skips the directory-symlink test on Windows checkouts without Developer Mode, in addition to its other local modifications)
- Local: `src/utils/output-decoder.ts`, `test/bash-nul-redirect.test.ts`, `test/output-decoder.test.ts`
- Changes: `rewriteCmdNulRedirects()` rewrites CMD-style `2>nul` redirects to `/dev/null` before spawning, preventing creation of a reserved-name `nul` file; `OutputDecoder` re-decodes non-UTF-8 console output with the detected OEM code page (registry `OEMCP`), with a `rewound` protocol so the executor and accumulator rebuild derived text views without losing raw bytes.
- Upstream assumptions: bash execution flows through `createLocalBashOperations` and decodes output in `bash-executor.ts`/`output-accumulator.ts`; both call sites must keep feeding the decoder and honor `rewound`/`flush()`.
- Verify: `test/bash-nul-redirect.test.ts`, `test/output-decoder.test.ts`; on Windows, run a CJK-emitting console command (for example `ipconfig`) and a `2>nul` command in a real session.

## 4. Between-tool-batch auto-compaction

Long tool loops are checked after a completed tool batch — or before continuing with queued steering/follow-up messages — and before the next provider request; over-threshold context is compacted and the same run continues. Failures, aborts, and unsafe retained context fail closed; a voluntary extension cancel (`session_before_compact` → `{ cancel: true }`) instead lets the run continue and skips further mid-turn checks for that run. The event carries a `timing` field (`"manual" | "midTurn" | "postRun" | "prePrompt"`) so extensions can tell cancel consequences apart.

- Hybrid: `src/core/agent-session.ts` (`_maybeCompactBeforeNextToolTurn()` via `prepareNextTurnWithContext`, `_runAutoCompactionWithOutcome()`, stop-after-turn and mid-turn-declined flags, stale-usage estimation, `CONTEXT_REMAINS_OVER_COMPACTION_THRESHOLD`/`NOTHING_TO_COMPACT_WITHIN_KEEP_WINDOW`), `src/core/extensions/types.ts` (`CompactionTiming`, `SessionBeforeCompactEvent.timing`), `src/core/extensions/index.ts` (re-exports `CompactionTiming`), `src/modes/interactive/interactive-mode.ts` (`turn_start` restores the working indicator; `compaction_end` can render a result and a warning together), `test/agent-session-auto-compaction-queue.test.ts` (asserts the mid-turn `timing` value), `docs/compaction.md`, `docs/extensions.md`
- Upstream assumptions: the stateful Agent exposes `prepareNextTurnWithContext` as a public callback and does not expose a low-level graceful turn-stop callback, so exceptional paths are represented as explicit error/aborted lifecycle boundaries.
- Upstreamed: the headers-only request auth relaxation (`_getRequiredRequestAuth` accepting `headers` without `apiKey`, [#5871](https://github.com/earendil-works/pi/issues/5871)) shipped upstream in v0.82.1; the remaining delta in `_getRequiredRequestAuth`/`_getSummarizationRequestAuth` is the shared-delegation refactor and the compaction changes.
- Verify: `test/suite/agent-session-compaction.test.ts`, `test/suite/agent-session-queue.test.ts`, `test/interactive-mode-compaction.test.ts`, `test/agent-session-concurrent.test.ts`, `test/suite/harness.ts`, `test/suite/regressions/2023-*.test.ts`, `test/suite/regressions/4167-*.test.ts`.

## 5. Native tool presentation and tool grouping

Native tool calls use a consistent `●` call and `│` result chrome with bounded fallback output, and consecutive explore-type tools collapse into one group.

- Hybrid: `src/modes/interactive/components/tool-execution.ts`, `src/modes/interactive/components/index.ts`, `src/modes/interactive/interactive-mode.ts` (component construction and grouping), `src/core/tools/bash.ts` (call/result rendering), `src/core/tools/edit.ts`, `src/core/tools/find.ts`, `src/core/tools/read.ts`, `src/core/tools/tool-definition-wrapper.ts`, `src/core/extensions/types.ts` (`toolGroup`, `toolGroupSummary`), `src/core/keybindings.ts` (`app.list.toggle`)
- Local: `src/modes/interactive/components/tool-group.ts`, `src/types/highlight-js.d.ts`, `test/helpers/virtual-terminal.ts`
- Changes: background-box shells and the JSON-dump fallback are replaced by prefix chrome and a 10-line bounded fallback; `toolGroup` is presentation-only metadata carried through a coding-agent-local `PresentableAgentTool` intersection type; bash calls render syntax-highlighted, width-fitted previews with a running-duration indicator only while active.
- Upstream assumptions: tool render entry points remain `renderCall`/`renderResult` with `ToolRenderContext`; upstream execution changes must be integrated before adapting presentation; do not change tool schemas or result structures for display-only work.
- Verify: `test/tool-execution-component.test.ts`, `test/bash-tool-rendering.test.ts`; in a real TTY check pending, success, error, collapsed, and expanded states plus group collapse/expand.

## 6. Bundled themes

- Hybrid: `src/modes/interactive/theme/theme.ts` (built-in themes load from a `BUILTIN_THEME_NAMES` list; watcher checks `getBuiltinThemes()`)
- Local: `src/modes/interactive/theme/ice-cream-dark.json`, `src/modes/interactive/theme/ice-cream-light.json`
- Verify: `test/theme-picker.test.ts`; `/theme` picker shows all four built-ins.

## 7. Bundled extensions

Personal workflow features are self-contained hidden built-ins using the public Extension API; only registration touches a hybrid file.

- Hybrid: `src/extensions/index.ts` (registers deepwiki, plan, question, rewind, router, statusline, subagent, todo alongside upstream's `llama.cpp`)
- Local: `src/extensions/{deepwiki,plan,question,rewind,router,statusline,subagent,todo}/**`, `test/plan-extension.test.ts`, `test/rewind-*.test.ts`, `test/subagent-*.test.ts`
- Upstream assumptions: `InlineExtension` registration and the Extension API surface used by these extensions stay stable; no cross-extension internal imports. Rewind additionally assumes `navigateTree`'s leaf rules (user/custom_message target → leaf = parent; other targets → leaf = target) and that `before_agent_start` fires once per `prompt()` (steering/follow-ups are consumed inside the same run). Plan additionally assumes `setActiveTools` takes effect on the next LLM request within the same run, `agent_settled` fires once per fully settled run, `AgentToolResult.terminate` ends the run after the tool batch, and the per-run system prompt override is not rebuilt mid-run.
- Verify: `test/plan-extension.test.ts`, `test/rewind-*.test.ts`, `test/subagent-*.test.ts`, `test/extensions-discovery.test.ts`; `/reload` and `/tree` in a real TTY for lifecycle extensions.

## 8. Atomic terminal writes for IME stability

pi-tui emits each render pass as several separate stdout writes: the frame wrapped in synchronized output (CSI ?2026h/l), then a relative cursor move that parks the hardware cursor at the caret for IME composition, then a cursor visibility toggle. Terminals that anchor the IME candidate window to the hardware cursor (Windows Terminal and other ConPTY hosts, WezTerm; upstream [#6289](https://github.com/earendil-works/pi/issues/6289), [#5200](https://github.com/earendil-works/pi/issues/5200), [#827](https://github.com/earendil-works/pi/issues/827)) can process the frame write before the reposition write arrives, making the candidate window jump between the caret and the end of the repainted input line on every keystroke. The distribution constructs the TUI with a `CoalescingTerminal` that merges all writes issued within one synchronous task into a single atomic stdout write, using only the public `Terminal`/`ProcessTerminal` API.

- Hybrid: `src/cli/startup-ui.ts`, `src/cli/config-selector.ts`, `src/modes/interactive/interactive-mode.ts` (construct `CoalescingTerminal` instead of `ProcessTerminal`)
- Local: `src/utils/coalescing-terminal.ts`, `test/coalescing-terminal.test.ts`
- Upstream assumptions: `TUI` accepts any `Terminal` implementation; `ProcessTerminal` keeps `write`, `moveBy`, cursor visibility, and clear helpers overridable; `ProcessTerminal.stop()` writes its teardown sequences directly to stdout (the override flushes pending output first). If upstream folds the IME cursor reposition into the synchronized-output block and a single write, the wrapper becomes redundant but stays harmless.
- Verify: `test/coalescing-terminal.test.ts`; on Windows Terminal with a CJK IME, type into the editor and confirm the candidate window stays at the caret instead of jumping toward the right edge.

## 9. Miscellaneous

- Hybrid: `CHANGELOG.md` (distribution changelog)
- Local: `AGENTS.md`, `README.md`, `docs/**`, `examples/**`, `maintainers/**` (distribution-owned documentation and examples; see [upstream-sync.md](upstream-sync.md) for ownership policy)
