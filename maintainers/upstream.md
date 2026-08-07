# Upstream synchronization

Synchronize this standalone package only from an exact upstream release tag. Follow [`AGENTS.md`](../AGENTS.md); use [release.md](release.md) only after synchronization is complete.

## Upstream baseline and boundary check

The [`upstream.json`](upstream.json) manifest pins the upstream repository, release tag, commit, `sourceSubtree`, and root-mapped `sourceTree`. The tag's subtree tree is the comparison baseline, not `HEAD` or a branch tip.

Run `npm run diff:upstream` to inspect the full worktree path classification report against the baseline tag, or `npm run diff:upstream -- --check` to verify baseline integrity and runtime dependency ranges as a concise release gate. It is a review aid, not a substitute for understanding the release diff.

Keep durable human context here when a meaningful local deviation changes.

## Synchronization runbook

1. Start from a clean synchronization branch. Fetch upstream tags and select an exact stable release tag; never synchronize from `upstream/main`.

   ```bash
   git fetch upstream --tags
   export TARGET_TAG=v<version>
   BASELINE_TREE="$(node -p "require('./maintainers/upstream.json').sourceTree")"
   SOURCE_SUBTREE="$(node -p "require('./maintainers/upstream.json').sourceSubtree")"
   TARGET_COMMIT="$(git rev-parse --verify "refs/tags/$TARGET_TAG^{commit}")"
   TARGET_TREE="$(git rev-parse --verify "$TARGET_COMMIT:$SOURCE_SUBTREE")"
   git diff --stat "$BASELINE_TREE" "$TARGET_TREE"
   ```

2. Resolve the target commit and the coding-agent subtree tree. Compare that tree with the recorded `sourceTree`, then read the relevant source, tests, public API, documentation, and examples. Triage each change as adopt, defer, or not applicable in the branch review.
3. Apply compatible behavior without importing workspace assumptions, vendoring dependencies, or changing upstream tool contracts for display-only behavior. Update local tests and distribution documentation for what ships.
4. If the adopted release needs newer runtime packages, set the three direct runtime dependencies to compatible exact published versions, regenerate the shrinkwrap, and run `npm run check:pinned-deps`.
5. When source, tests, documentation, dependencies, and shrinkwrap are final, update the manifest to the selected repository, tag, commit, subtree, and resolved target tree. Run `npm run diff:upstream` to inspect the full worktree path report, and `npm run diff:upstream -- --check` as a release gate.
6. Run focused tests for every changed subsystem, a real-TTY check for interactive behavior, then `npm run build`, `npm run check`, and the diff command. Resolve failures before handoff.

## Durable notes for local deviations

Re-read these notes whenever the related upstream lifecycle or renderer behavior changes. Prefer public Extension API or a local adapter before changing an upstream-aligned runtime surface.

- **Standalone package and bundled features:** This is a standalone `@astralyn/pi` package with exact published runtime dependencies. Bundled workflow extensions remain independent public-API consumers; their model-facing output stays bounded. Native themes and package documentation are distribution-owned.
- **Mid-turn compaction (high risk):** Context is checked after a completed tool batch and before queued steering or follow-up work reaches the next provider request. Safe compaction continues the same run; unsafe retained context, aborts, and failures stop at an explicit lifecycle boundary. Do not simulate a graceful upstream turn stop where the Agent API does not provide one. Exercise continuation, cancellation, unavailable cut points, retained-context failure, and queued work in focused tests and a real TTY.
- **Native tool presentation (high risk):** Keep native call/result chrome, bounded collapsed output, renderer refreshes, and keybinding-aware expansion hints without changing tool schemas, execution protocols, or model-facing results. Verify the affected pending, success, error, collapsed, expanded, grouped, and delayed-progress states in focused tests and a real TTY.
- **Terminal output and render-state coupling (high risk):** Coalesced writes support IME stability and guarded scrollback preservation. Only rewrite recognized full-render frames; unknown shapes, size changes, or invalid state must use the safe fallback. Viewport preservation reads `TuiMainScreen.captureRenderState().previousViewportTop` (public API) and depends on pi-tui writing each full-redraw frame before updating that bookkeeping; validate the value and fall back rather than trusting it. The preservation window (run start until the user's next input) lives in `CoalescingTerminal` and observes input on the shared terminal's own input path, so renderer switches must keep reusing that terminal. Test final-screen equivalence and scrollback, plus Windows Terminal IME, scrolling, and tall expanded results.
- **Platform and time-sensitive UI:** Keep Windows shell normalization narrow, and ensure interactive timers and selectors derive from deadlines, repaint only while active, and dispose on replacement or shutdown. Re-check Windows process behavior and real-TTY lifecycle interactions after upstream changes.
