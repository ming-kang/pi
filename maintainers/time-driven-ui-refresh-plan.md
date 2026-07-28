# Time-driven UI refresh work plan

> Temporary implementation handoff and progress log for the time-driven UI refresh work. Update this file after every work package and commit it together with that package. Keep it until automated verification and owner-led real-TTY acceptance are complete, then remove it in the final acceptance commit.

## Objective

Do not add an isolated `setInterval` inside Subagent. First give the native tool shell an explicit, lifecycle-safe render refresh capability, then use it for Subagent elapsed time and retry countdowns before fixing the other confirmed time-driven UI defects.

## Working rules

- Preserve tool schemas, execution protocols, and model-facing result content unless a work package explicitly calls for optional bounded UI metadata.
- Keep `rendersOwnProgress` responsible only for suppressing the generic `Running…` row.
- Put native tool refresh behavior in `src/modes/interactive/components/tool-execution.ts`; do not recreate it inside extensions.
- Every timer must have an explicit partial/running lifetime and an idempotent cleanup path.
- Update this document after each completed work package and commit it with the implementation and tests for that package.
- Run focused tests for changed behavior before completing each work package.
- Do not mark final acceptance complete until the owner has performed the real-TTY checks.

## Progress

| Work package                              | Status    | Commit      | Verification          |
| ----------------------------------------- | --------- | ----------- | --------------------- |
| Plan document                             | Completed | `be6166d4` | Initial plan recorded                |
| WP1: Tool progress/render refresh split   | Completed | `025fb307` | 4 focused files, 51 tests; check |
| WP2: Subagent independent elapsed refresh | Completed | `b5436ecf` | 4 focused files, 69 tests; check |
| WP3: Subagent retry countdown             | Completed | This commit | 7 focused files, 60 tests; check |
| WP4: Other time/timer defects             | Pending   | —           | —                     |
| WP5: Documentation and delta registry     | Pending   | —           | —                     |
| Automated verification                    | Pending   | —           | —                     |
| Owner real-TTY acceptance                 | Pending   | —           | —                     |

## WP1: Split progress presentation from render refresh

### Goal

Allow a tool to:

- render its own progress without showing the generic `Running…` row; and
- still ask the native shell to rebuild its renderer periodically.

### Implementation

#### `src/core/extensions/types.ts`

Add an explicit rendering refresh option:

```ts
/** While partial, rebuild this tool row at the given interval. */
renderRefreshIntervalMs?: number;
```

Keep:

```ts
rendersOwnProgress?: boolean;
```

The responsibilities are separate:

- `rendersOwnProgress` controls only the generic `Running…` row.
- `renderRefreshIntervalMs` controls only periodic invalidation.

#### `src/modes/interactive/components/tool-execution.ts`

Refactor the current timer so that:

1. Default tools continue refreshing the generic Running row once per second.
2. Custom tools may declare an independent refresh interval.
3. If both requirements apply, one timer uses the shorter interval.
4. Each tick calls `invalidate()` and `ui.requestRender()`.
5. Final result, abort, and disposal stop the timer.
6. Extension-provided intervals are constrained to a safe range, with a minimum such as 250ms.
7. The timer is unreferenced where supported so an orphan cannot hold the process open.

### Lifecycle hardening

Add an idempotent `dispose()` to `ToolExecutionComponent` that:

- clears the refresh timer;
- marks the component disposed; and
- ignores late asynchronous image conversion callbacks.

Centralize pending-tool cleanup in `interactive-mode.ts`: dispose each pending tool before clearing the map.

### Tests

In `test/tool-execution-component.test.ts`, cover:

- own-progress tools rebuild once per configured interval;
- no extra generic `Running…` row appears;
- normal tools retain existing behavior;
- final results stop refresh;
- disposal stops refresh;
- repeated disposal is safe; and
- abnormal pending-tool cleanup leaves no timer behind.

## WP2: Enable independent Subagent refresh

### Implementation

In `src/extensions/subagent/index.ts`:

```ts
rendersOwnProgress: true,
renderRefreshIntervalMs: 1000,
```

Keep `rendersOwnProgress` to avoid a duplicate generic Running row.

The existing `liveElapsed()` in `src/extensions/subagent/render.ts` can continue reading the wall clock. Once the shell rebuilds the renderer every second, these views update independently:

- collapsed single-run elapsed time;
- parallel header elapsed time;
- each parallel run row; and
- expanded metrics.

### Tests

Add integration coverage between the shell and the real Subagent renderer:

- a silent run advances from approximately `2.0s` to `3.0s` without details updates;
- single, parallel, collapsed, and expanded views update;
- two parallel Subagent call cards refresh independently;
- refresh does not depend on the Working spinner;
- final elapsed time remains fixed; and
- no duplicate generic Running row appears.

## WP3: Replace the static Subagent retry countdown

The current `Retrying … in 8s` activity is a one-time string. Replace it with structured UI state rather than parsing display text.

### Type

Add optional bounded UI metadata to `SubagentRunDetails`:

```ts
retry?: {
  attempt: number;
  maxAttempts: number;
  deadline: number;
  error: string;
};
```

This metadata may appear in tool `details`, but must not change model-facing `content`.

### Behavior

- `auto_retry_start` sets an absolute deadline.
- The renderer computes remaining seconds from the deadline and `Date.now()`.
- At zero it displays `Retrying now…`.
- `auto_retry_end`, success, failure, and abort clear retry state.
- Task-level retry uses the same representation.
- Error text remains bounded.

### Tests

Cover:

- `8s → 7s → 1s → Retrying now…`;
- provider and task-level retry;
- abort cleanup;
- no retry metadata in final settled details; and
- bounded error display.

## WP4: Fix the other confirmed time/timer defects

### WP4.1: Armin rain never settles

In `src/modes/interactive/components/armin.ts`, treat a completely empty bitmap column as settled instead of allowing its drop to fall forever:

```ts
if (targetRow < 0) {
  drop.settled = DISPLAY_HEIGHT;
  continue;
}
```

Add a deterministic rain test proving that the interval stops after finitely many ticks and stops requesting renders.

### WP4.2: `/resume` relative ages

In `src/modes/interactive/components/session-selector.ts`:

- request a render once per minute while the selector is open;
- continue deriving display age from the current wall clock; and
- clear the timer when the selector closes.

Give the generic selector host an optional disposal call so session status timeouts are also cleaned up.

### WP4.3: `/tree` timestamps across midnight

When label timestamps are visible, schedule a one-shot refresh at the next local midnight. Clear it when the selector closes.

### WP4.4: Deadline-based `CountdownTimer`

In `src/modes/interactive/components/countdown-timer.ts`, derive remaining seconds from an absolute deadline rather than decrementing a counter. Event-loop stalls and machine sleep must not extend a wall-clock timeout.

## WP5: Documentation and delta registry

Update:

- `docs/extensions.md`
  - document `renderRefreshIntervalMs`;
  - distinguish it from `rendersOwnProgress`; and
  - explain that refresh runs only during the partial lifecycle.
- `docs/bundled/extensions/subagent.md`
  - describe independently refreshed elapsed time and retry countdowns.
- `docs/bundled/tool-presentation.md`
- `CHANGELOG.md`
- `maintainers/upstream.json`
- `maintainers/delta.md`

Verify the delta registry with:

```bash
npm run diff:upstream -- --check
```

## Automated verification

Run focused affected tests, including:

```bash
node node_modules/vitest/dist/cli.js --run \
  test/tool-execution-component.test.ts \
  test/subagent-render.test.ts \
  test/subagent-runner.test.ts \
  test/subagent-task-retry.test.ts \
  test/extension-selector.test.ts \
  test/session-selector-path-delete.test.ts
```

Then run:

```bash
npm run check
npm run build
npm run check:docs
npm run diff:upstream -- --check
git diff --check
```

On Windows, run the complete local suite through:

```bash
npm run test:isolated
```

Classify platform-only failures separately, but do not dismiss any focused failure in changed code.

## Owner real-TTY acceptance

The final acceptance checkpoint belongs to the owner. Verify:

1. Start two simultaneously running Subagents that remain silent for an extended period.
2. Both elapsed clocks advance independently about once per second.
3. Hide the Working indicator and confirm elapsed clocks still advance.
4. Expand with `Ctrl+O`; elapsed time continues and no duplicate Running row appears.
5. Run a silent long command inside a Subagent; elapsed time continues.
6. Trigger a retry and confirm the countdown decreases once per second.
7. Abort and exercise `/reload` and `/tree`; old timers do not continue redrawing.
8. Force the `/armin` rain effect; CPU/render activity returns to idle after completion.
9. Keep `/resume` open for more than a minute; relative age updates automatically.

After owner acceptance, update this document with the result and remove it in the final acceptance commit.

## Recommended implementation order

1. WP1: shell refresh capability and lifecycle.
2. WP2: Subagent elapsed time.
3. WP3: retry countdown.
4. WP4: remaining timer defects.
5. WP5: documentation and delta registration.
6. Automated verification.
7. Owner real-TTY acceptance.

WP1-WP3 form the core fix. Each work package must nevertheless update and commit this progress log together with its own implementation and verification evidence.

## Decisions and findings

- No extension-owned Subagent interval: refresh belongs to the native tool presentation layer.
- A plain TUI `requestRender()` does not recalculate Subagent elapsed text because the current renderer creates static `Text` components.
- `rendersOwnProgress` currently suppresses both generic content and the shell timer; WP1 intentionally separates those concerns.
- Time displays use absolute timestamps or deadlines; intervals only trigger rendering.
- Timer cleanup is a correctness requirement, not an optional optimization.
- When generic progress and an explicit renderer interval both apply, the shared timer uses the shorter interval. The explicit value therefore defines the maximum refresh gap, not a promise that no other shell concern will rebuild sooner.
- WP1 also keys pending Kitty conversions by source image and ignores stale or post-disposal completion, preventing detached or superseded results from requesting renders.

## Completed implementation notes

### WP1

- Added bounded `renderRefreshIntervalMs` support (250ms–60s) without changing generic progress presentation.
- Added idempotent disposal for individual and grouped tool components.
- Centralized pending-tool and chat-tool disposal across rebuild, session replacement, run end, and shutdown paths.
- Guarded renderer invalidation and asynchronous Kitty conversion completion after disposal.
- Prevented a superseded partial image conversion from overwriting a newer image at the same result index.
- Updated borrowed-`InteractiveMode` regression fixtures for the new cleanup methods.
- Verification passed:
  - `test/tool-execution-component.test.ts`
  - `test/bash-tool-rendering.test.ts`
  - `test/interactive-mode-compaction.test.ts`
  - `test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts`
  - 51 focused tests total
  - `npm run check`

### WP2

- Registered Subagent with a 1000ms native-shell renderer refresh while retaining `rendersOwnProgress: true`.
- Added integration coverage using the actual registered Subagent definition and `ToolExecutionComponent`.
- Confirmed silent single-run elapsed time advances in collapsed and expanded views without partial-result updates.
- Confirmed separate single and parallel call cards advance from their own start times, including expanded parallel metrics.
- Confirmed final results stop refreshing and no duplicate generic `Running…` row appears.
- The test TUI intentionally has no Working loader, proving the clock does not depend on spinner redraws.
- Verification passed:
  - `test/subagent-live-refresh.test.ts`
  - `test/subagent-render.test.ts`
  - `test/subagent-extension.test.ts`
  - `test/tool-execution-component.test.ts`
  - 69 focused tests total
  - `npm run check`

### WP3

- Added optional bounded retry metadata with attempt, maximum attempts, absolute deadline, and compact error text; final model-facing result content is unchanged.
- Provider auto-retry and task-level preflight retry now use the same deadline representation.
- The native Subagent shell refresh drives `8s → 7s → 1s → Retrying now…` in collapsed and expanded views.
- Queued task retries are visible in parallel cards and prioritized into the four-row collapsed window without changing stable task ordinals.
- Retry metadata participates in progress deduplication and is removed on retry end, resumed work, success, failure, parent abort, session shutdown, and final result construction.
- Task backoff registers its own session-shutdown aborter while the worker session is between attempts.
- SDK abort registration now covers resource/session initialization, preventing a prompt from starting after a parent or shutdown abort during initialization.
- Retry errors are normalized and bounded to 160 UTF-8 bytes in live and bounded details.
- Verification passed:
  - `test/subagent-sdk-abort.test.ts`
  - `test/subagent-retry.test.ts`
  - `test/subagent-live-refresh.test.ts`
  - `test/subagent-render.test.ts`
  - `test/subagent-task-retry.test.ts`
  - `test/subagent-activity.test.ts`
  - `test/subagent-runner.test.ts`
  - 60 focused tests total
  - `npm run check`

## Commit log

- Initial plan document: `be6166d4 docs: add time-driven UI refresh plan`.
- WP1: `025fb307 feat: add lifecycle-safe tool render refresh`.
- WP2: `b5436ecf fix: refresh live Subagent elapsed time`.
- WP3: `fix: make Subagent retry countdown live` (this commit).
