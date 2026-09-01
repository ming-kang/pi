# Upstream synchronization

Synchronize this standalone package only from an exact upstream release tag. Follow [`AGENTS.md`](../AGENTS.md); use [release.md](release.md) only after synchronization is complete.

## Upstream baseline and boundary check

The [`upstream.json`](upstream.json) manifest pins the upstream repository, release tag, commit, `sourceSubtree`, and root-mapped `sourceTree`. The tag's subtree tree is the comparison baseline, not `HEAD` or a branch tip.

Run `npm run diff:upstream` to inspect the full worktree path classification report against the baseline tag, `npm run diff:upstream -- --check` to verify baseline integrity, all five runtime dependency ranges, and ledger coverage as a concise CI/release gate, or `npm run diff:upstream -- --target v<version>` to classify an upstream release diff against the ledger and fork-owned additions in the clean `HEAD` tree. It is a review aid, not a substitute for understanding the release diff.

## Deviation ledger

[`deltas.json`](deltas.json) registers every modified or dropped upstream path (M/T/D) with a category, a one-line intent, and optional covering tests. Entries ending in `/` register a whole directory. The diff report annotates each path with its ledger entry; `--check` fails on unregistered deviations and stale entries. Update the ledger whenever a deviation is added, removed, or changes meaning — especially during upstream synchronization, where it answers "why does this file differ and can the upstream version replace it" without re-deriving history.

Categories encode why a deviation exists and how to treat it during synchronization:

- `distribution` — required for the standalone package to exist; never adopt the upstream version.
- `bugfix` — fixes an upstream defect ahead of upstream; check each synchronization whether upstream fixed it and retire the entry once it has.
- `windows-compat` — upstream behavior correct on POSIX but broken on native Windows; treat like `bugfix`, but expect longer-lived entries and verify with a Windows reproduction.
- `ui` — the fork's TUI presentation identity; permanent, merge upstream changes into it by hand.
- `extension-support` — additions to the upstream Extension API contract surface (`src/core/extensions/types.ts`, its barrel, `src/core/tools/tool-definition-wrapper.ts`); each intent names what drives the addition (a fork UI feature, the compaction controller, or a bundled-extension need). Merge upstream API evolution by hand, and retire an addition when it loses all consumers or upstream grows an equivalent.

Keep durable human context here when a meaningful local deviation changes.

## Synchronization runbook

1. Start from a clean synchronization branch. Fetch upstream tags, select an exact stable release tag (never synchronize from `upstream/main`), and classify the release diff against the deviation ledger:

   ```bash
   git fetch upstream --tags
   npm run diff:upstream -- --target v<version>
   ```

   Changes touching registered deviations or colliding with fork-owned additions need per-path review; only changes clear of both are adoption candidates. Removed upstream paths need drop-or-keep decisions. Read the relevant source, tests, public API, documentation, and examples, and triage each change as adopt, defer, or not applicable in the branch review.
2. Apply compatible behavior without importing workspace assumptions, vendoring dependencies, or changing upstream tool contracts for display-only behavior. Update local tests and distribution documentation for what ships.
3. If the adopted release needs newer runtime packages, set all five direct upstream runtime dependencies to compatible exact published versions, regenerate the shrinkwrap, and run `npm run check:pinned-deps`.
4. When source, tests, documentation, dependencies, and shrinkwrap are final, update the manifest to the selected repository, tag, commit, subtree, and resolved target tree. Run `npm run diff:upstream` to inspect the full worktree path report, and `npm run diff:upstream -- --check` as a release gate.
5. Run focused tests for every changed subsystem, a real-TTY check for interactive behavior, then `npm run build`, `npm run check`, and the diff command. Resolve failures before handoff.

## Durable notes for local deviations

Re-read these notes whenever the related upstream lifecycle or renderer behavior changes. Prefer public Extension API or a local adapter before changing an upstream-aligned runtime surface.

- **Standalone package and bundled features:** This is a standalone `@astralyn/pi` package with exact published runtime dependencies. Bundled workflow extensions remain independent public-API consumers; their model-facing output stays bounded. Native themes and package documentation are distribution-owned. Within `src/extensions/`, only `llama` is upstream's own bundled extension (kept byte-identical to the baseline); every other bundled extension is a fork addition.
- **Mid-turn compaction (high risk):** Context is checked after a completed tool batch and before queued steering or follow-up work reaches the next provider request. Safe compaction continues the same run; unsafe retained context, aborts, and failures stop at an explicit lifecycle boundary. Do not simulate a graceful upstream turn stop where the Agent API does not provide one. Exercise continuation, cancellation, unavailable cut points, retained-context failure, and queued work in focused tests and a real TTY.
- **Native tool presentation (high risk):** Keep native call/result chrome, bounded collapsed output, renderer refreshes, and keybinding-aware expansion hints without changing tool schemas, execution protocols, or model-facing results. Verify the affected pending, success, error, collapsed, expanded, grouped, and delayed-progress states in focused tests and a real TTY.
- **Platform and time-sensitive UI:** Keep Windows shell normalization narrow, and ensure interactive timers and selectors derive from deadlines, repaint only while active, and dispose on replacement or shutdown. Re-check Windows process behavior and real-TTY lifecycle interactions after upstream changes.
