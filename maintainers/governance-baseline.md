# Governance baseline

**Historical snapshot:** 2026-07-29
**Pre-report commit:** `c61cb512be7ece81ac0973f492103ef09667b932`
**Comparison start:** `2181be78afd881ce398930f8939ec21a0a7b6190`

This is the durable governance closeout record, not a live registry. [`upstream.json`](upstream.json) remains the sole machine authority for the baseline, path ownership, units, risks, assumptions, and budgets. Do not manually maintain these counts here as a second registry.

## Baseline identity

The reviewed baseline is `earendil-works/pi` `v0.82.1`, commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`, rooted at subtree `packages/coding-agent` with tree `95bc4c0801da1c32db72b9bc876caf6afa3ca4d4`. The coding-agent version and its exact three runtime dependencies are all `0.82.1`: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui`.

## Registry migration

| Concern | Before | After |
| --- | --- | --- |
| Manifest schema | v2 | v3 |
| Canonical `sourceTree` | absent | present |
| Hybrid paths | 70 | 70; classified and frozen, with no net reduction yet |
| Dropped registry | 3 entries resolving to 4 files (`install-lock/**` plus two tests) | 4 exact paths |
| Delta units | 10 narrative units, including Miscellaneous, with no machine IDs | 9 stable machine IDs; Miscellaneous retired into owned scope |
| Distribution-owned registry | flat `localOnly`, 44 patterns | `owned.overlays`, 3, plus `owned.additions`, 67 registry entries |
| Limits and review data | no budgets, risk, or private-assumption record | exact ratchet ceilings, risk, disposition, and assumption metadata |

The old and new owned-pattern counts are not a direct complexity comparison: the new registry separates overlays from additions and replaces broad globs with narrower accountable entries where practical.

## Measured gate at this snapshot

Including this report, the boundary gate measured **356 differences**: 70 hybrid, 282 distribution-owned, 4 dropped, and 0 unregistered. All budgeted measurements were at the ratchet ceiling.

| Budget | Ceiling | Current |
| --- | ---: | ---: |
| Hybrid paths | 70 | 70 |
| Hybrid source paths | 42 | 42 |
| Dropped paths | 4 | 4 |
| Delta units | 9 | 9 |
| High-risk units | 3 | 3 |
| Private upstream assumptions | 1 | 1 |

Any reduction must ratchet its ceiling down. Any growth requires owner approval and the registry/rationale review described in [delta.md](delta.md).

## Unit baseline

| ID | Route / disposition | Risk | Modified / dropped | Key load-bearing seam |
| --- | --- | --- | ---: | --- |
| `dist-standalone` | Keep / keep | medium | 17 / 2 | standalone package identity and resolution |
| `dist-attribution` | Isolate / isolate | low | 4 / 0 | attribution separated from install telemetry |
| `plat-windows-bash` | Upstream / upstream | low | 3 / 0 | POSIX-shell normalization on Windows |
| `core-mid-turn-compaction` | Keep / keep | high | 9 / 0 | safe between-tool-batch continuation |
| `ui-tool-presentation` | Isolate / isolate | high | 16 / 0 | native call/result rendering lifecycle |
| `ui-bundled-themes` | Keep / keep | low | 2 / 0 | theme assets and nested ANSI restoration |
| `ext-bundled` | Isolate / isolate | medium | 10 / 2 | public Extension API compatibility adapters |
| `ui-terminal-output` | Isolate / isolate | high | 3 / 0 | atomic writes and guarded scrollback preservation |
| `ui-time-lifecycle` | Upstream / upstream | medium | 6 / 0 | deadline-driven selector and UI disposal |

The sole private assumption is `@earendil-works/pi-tui:TUI.previousViewportTop` in `ui-terminal-output`. Its validation and fallback are load-bearing; it is not a supported API.

### Route summary

- **Keep:** 3 units, 28 modified + 2 dropped.
- **Isolate:** 4 units, 33 modified + 2 dropped.
- **Upstream:** 2 units, 9 modified + 0 dropped.
- **Remove:** no active unit. Plan mode removal is complete. Future removal follows the affected unit's exit criteria and immediately lowers the relevant budgets and registries.

## Distribution-owned scope

Overlays are README, documentation, and examples. Additions cover standalone configuration, CI, and maintainer tooling; seven distribution extensions (deepwiki, question, rewind, router, statusline, subagent, and todo); UI/theme utilities; and focused tests. `llama.cpp` is upstream-aligned, not distribution-owned.

## Documentation consolidation

- The changelog is bounded at the first Fork release, `0.81.1-1`, and dead links were removed.
- Public entry points consistently name `@astralyn/pi`, Node `>=22.19`, and eight built-in extensions; stale monorepo and private-source references were removed.
- Six large API documents were audited, with a net 377-line reduction and no API expansion; stale-term rules were added.
- Intentional overlaps have distinct roles: `README.md` is the package overview, `docs/index.md` is the documentation map, and `docs/quickstart.md` owns setup; `docs/docs.json` owns machine navigation; the bundled-extension catalog covers shipped features while the examples catalog covers developer samples; package declarations remain authoritative over reader-oriented inline TypeScript snippets.
- Large API pages were not split because each has a cohesive audience and topic; splitting would add routing duplication rather than useful clarity.

## Clean rehearsal evidence

A clean rehearsal used a fresh `--no-local`, no-tags clone. Before fetching, it had no `node_modules`, tag, `sourceTree`, or `upstream-extract`; it then performed an exact depth-1 tag fetch and matched the expected hashes. With a brand-new npm cache, `npm ci`, audit, build, check, the diff gate, and the synthetic exact-baseline check passed. The final clone was clean and the temporary clone was removed.

The release audit snapshot found 306 stable tags, latest `v0.82.1`, and 0 newer tags. This is time-sensitive, informational evidence only, not a claim that the latest upstream result remains true indefinitely.

## Remaining risk and priorities

### P0 — release safety

Re-review all three high-risk units and the private assumption after every dependency or baseline change. Ubuntu's full suite is authoritative; use focused Windows checks plus a real TTY for `nul` redirect, IME, and scrollback. Do not dismiss a focused failure in changed code as platform noise.

### P1 — shrink the delta

Upstream `plat-windows-bash` and `ui-time-lifecycle`; replace the private terminal-field reliance when a public upstream API exists while preserving the guarded fallback; seek upstream lifecycle and render hooks for compaction and tool UI.

### P2 — documentation automation

Consider TypeScript-fence compilation and semantic parity checks between the human index and `docs.json`, only if false-positive and maintenance costs stay low.

## Re-evaluation and next sync

Re-evaluate when the reviewed release tag, canonical source tree, exact runtime dependencies, terminal/frame behavior, Agent compaction lifecycle, renderer hooks, selector/timer lifecycle, Extension API, or Windows shell behavior changes. Also re-evaluate when an exit criterion in [delta.md](delta.md) is met or a boundary measurement can shrink.

For the next synchronization, follow [upstream-sync.md](upstream-sync.md) and [delta.md](delta.md): select a release tag, resolve its canonical subtree, triage and test changes, update exact dependencies and documentation, refresh the manifest last, run the boundary gate, and record any approved delta change with its rationale and ratchet adjustment.
