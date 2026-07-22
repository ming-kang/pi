# rewind — checkpoints & rewind

Per-edit file backups plus a `/rewind` settings menu. Instead of snapshotting the
whole working tree, rewind backs up **only the files Pi's `edit`/`write` tools are
about to change** — one `copyFile` before each edit. Cost is proportional to how
many files Pi changed, never to project size, so it never blocks the session
lifecycle (the old shadow-git design froze the UI in large multi-project
directories) and storage stays tiny.

## Behavior

Per turn: `before_agent_start` opens a snapshot frame (re-recording every tracked
file at its turn-start state, reusing the latest backup when unchanged);
`tool_call(edit|write)` backs up each newly edited file *before* it lands;
`agent_settled` persists the frame to the session JSONL as a `pi-rewind-snapshot`
custom entry **only when files changed**. Using `agent_settled` (not `agent_end`)
keeps auto-retry, overflow compaction-retry, and queued follow-ups in one logical
turn — `agent_end` can fire while Pi still continues. Requires **Pi ≥ 0.80.4**
(when `agent_settled` was added); older hosts never fire that event, so frames
would not finalize. Entries survive `/reload` and compaction; the index is
rebuilt from them on `session_start`.

- **Scope (deliberate trade-off):** rewind covers edits made through Pi's built-in
  `edit` and `write` tools. Files written by `bash` (redirects, codegen, `mv`) or
  edited by hand outside Pi are **not** tracked — same boundary as Claude Code's
  file-history. Rewind undoes *Pi's edits*, not arbitrary filesystem state.
- **Time-travel is via `/tree`.** Navigating to a node whose turn changed files
  prompts to restore them, listing the affected files (cwd-relative, up to 8
  then *"+N more"*) under *"Restore 3 files to this point?  (+120 / −40)"*
  when coarse line stats are available; choosing yes restores the work tree to
  that turn's start state. Nodes with no file changes navigate silently. Only
  files that actually differ are rewritten. Line totals are a bag-of-lines
  estimate (capped at 1 MB per file), not a full Myers diff.
- **`/rewind` is a settings + storage menu**, not a restore picker:
  - toggle rewind on/off,
  - set the auto-clean retention window,
  - inspect storage and prune (clean aged + orphaned / remove orphaned / remove
    all except current).
- **New files** created by `write` are tracked with a "did not exist" marker, so
  rewinding deletes them.
- **Resume/fork** hard-links the prior session's backup blobs into the new
  session (falling back to copy), so rewind keeps working without duplicating
  storage.

## Storage & cleanup

- **Layout:** `~/.pi/agent/rewind/`
  - `config.json` — `{ enabled, retentionDays, maxSnapshots }`
  - `backups/<sessionId>/<sha256(relpath)[:16]>@v<n>` — backup blobs (flat, hashed
    names keep paths short on Windows; mode preserved)
- **Auto-clean:** at `session_start`, backup directories older than
  `retentionDays` (default **30**, set in `/rewind`) are reclaimed, plus an
  **orphan sweep** of directories whose session id has no session JSONL (crashed
  sessions). The GC is time-boxed and deletion-capped so it never slows startup.
- The former `pi-config` storage layout is **not** read or migrated by this
  engine. Remove any old `~/.pi/agent/pi-config/` data manually if it is no
  longer needed.

## Limits

- Covers edits made through Pi's built-in `edit` and `write` tools only. Files written by `bash` or edited outside Pi are not tracked.
- A backup failure is swallowed — the edit proceeds without checkpointing rather than blocking the tool.
- `/rewind` on its own does not restore files. Restoration uses `/tree` — navigate to a turn and confirm the prompt.
- Restore is coarse: only files that differ are rewritten, but line totals are a bag-of-lines estimate (capped at 1 MB per file), not a full Myers diff.

## Implementation notes

- **Never blocks the edit.** Backup runs before the write lands; a backup failure is swallowed so the session never stalls.
- **Restore safety.** `applySnapshot` only rewrites files that differ and degrades gracefully on unreadable backups.
- **Change detection.** A file is re-backed-up only when its stat or content differs from the latest backup. Content comparison streams in 64 KiB chunks instead of buffering whole files up to the 25 MB cap.
- **Config is memory-cached.** `config.json` is re-read on `session_start` and updated in memory when `/rewind` saves.
- **Restore path is single-scan.** The `/tree` confirm pass caches changed absolute paths; IO is concurrency-capped (16).

**Files:**

- `index.ts` — lifecycle hooks (`tool_call`, `before_agent_start`, `agent_settled`, `session_start`, `session_before_tree`/`session_tree`, `session_shutdown`) and the `/rewind` command
- `engine.ts` — the file-history backup engine (track / snapshot / apply / resume-migrate), ported from Claude Code's file-history
- `snapshot.ts` — persisted snapshot data shapes (pure)
- `config.ts` — load/save `rewind/config.json`
- `gc.ts` — age + orphan storage reclamation; storage inventory for the menu
- `menu.ts` — the `/rewind` settings + storage menu
- `restore.ts` — `/tree`-target → snapshot matching and restore
- `paths.ts`, `text.ts`, `tool-path.ts` — private helpers owned by this plugin

Architecture informed by oh-my-pi (GPL-3.0) and Claude Code's file-history; independent implementation.
