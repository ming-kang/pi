# Statusline

Replaces Pi's built-in footer with a fixed, color-coded two-line status display using a balanced left/right layout. It registers no tool or command and has no configuration file. The footer auto-enables on `session_start` in TUI mode and clears itself on `session_shutdown`.

## What it shows

```text
DeepSeek V4 Pro (opencode-go) · xhigh          ~/Projects · main
CTX 2.1%/1.0M                    ↑13k ↓13k R440k CH99.4% $0.074
```

### Line 1 — session identity (left) · location (right)

**Left**

- **Model:** human-readable model name, falling back to the model id.
- **Provider:** the model source in parentheses, such as `(deepseek)` or `(opencode-go)`.
- **Effort:** the current runtime thinking level when the model supports reasoning and the level is not `off`.

**Right**

- **Working directory:** full cwd shortened against the home directory with `~`.
- **Git branch:** appended when available.

### Line 2 — context (left) · usage (right)

**Left**

- **Context:** used percentage plus context-window size. The percentage uses fixed semantic tiers: accent normally, warning above 40%, error above 80%.

**Right**

- `↑` cumulative input tokens.
- `↓` cumulative output tokens.
- `R` cumulative cache-read tokens.
- `W` cumulative cache-write tokens, omitted when zero.
- Cumulative totals include assistant requests, usage-bearing tool results, compaction summaries, branch summaries, and independently settled Background usage records on the active branch.
- `CH` cache-hit percentage for the latest assistant request, calculated as `cacheRead / (input + cacheRead + cacheWrite)` and shown only when that request used cache.
- `$` cumulative cost; `(sub)` is appended when the current model uses an OAuth subscription.

**Middle (optional)**

- Extension status text from `ctx.ui.setStatus()` is sorted by key and pinned to the center of the line — anchored to the absolute line center so it does not drift as the usage cluster grows, falling back to balancing the free space when the side zones collide with the center anchor. When space runs out it is dropped so CTX and usage stay readable. Plain text is muted; strings that already carry ANSI color are left unchanged.

Background billing uses the first valid `task-usage` record per execution ID; managed foreground results omit duplicate `usage`. Opening `/tasks`, detaching, or repeating `tasks read`/`wait` does not add billing. Accrued worker retry, cancellation, failure, and provider-supplied compaction usage is included when settled; missing usage is not fabricated. Quarantined late settlements are excluded from active totals. This does not change the footer's active-branch scope (session-wide statistics can include other branches), parent CTX estimate, or latest-parent-request `CH`. See the [persisted record format](../../session-format.md#background-records).

The built-in Tasks UI can supply centered status text such as `tasks 2 active · 1 finished`. These counts cover backgrounded executions; worker rows are not separate groups. The old prompt-stall watchdog and `waiting for input` counts are no longer generated.

Zero-value usage fields are omitted. Without any accounted usage, the right side of line 2 is empty; extension status stays centered either way.

## Narrow-width drop order

When the terminal is too narrow for the full layout:

**Line 1** uses the first complete pair that fits:

1. Model/provider/effort with the full path and git branch.
2. Model/provider/effort with the full path alone.
3. Model/provider/effort with the short path and git branch, then the short path alone.
4. Model/effort with the short path and git branch, then the short path alone.
5. Model/effort alone.

The short path is `~/basename` (or bare basename). Shortening the path or dropping the provider can make room for the branch again. If none of these pairs fits, the model/effort and short path are truncated.

**Line 2** (first drop → last):

1. Keep the fullest usage cluster that fits beside CTX, trying full usage, then without `W`, then without `W` and `R`.
2. Include centered extension status only if the selected pair leaves enough room.
3. If no usage variant fits, omit status and truncate CTX with the full usage cluster.

Status therefore yields to usage; it never causes an extra usage field to be dropped.

## Layout and colors

- Model name uses `toolTitle` and bold; provider uses `muted`.
- Effort uses Pi's thinking-level color.
- Context uses `accent`, `warning`, or `error` according to the fixed thresholds.
- Working directory uses `success`; Git branch uses `accent`.
- Usage statistics use `dim`; extension status text uses `muted`.
- Each line left-aligns its primary cluster and right-aligns the secondary cluster, filling the gap with spaces so wide terminals stay balanced.

Pi does not expose auto-compaction state to extension footer factories, so the native `(auto)` marker is intentionally not reproduced.

## Migration

The previous `/statusline` command and `~/.pi/agent/pi-config/statusline.json` configuration are no longer used. An existing config file is left untouched and may be removed manually.

## Limits

- Auto-enables only in TUI mode on `session_start`; RPC and print modes have no TUI footer.
- The native `(auto)` compaction marker is not reproduced because Pi does not expose that state to extensions.

## Implementation notes

Footer paint runs on every TUI render. Each footer instance keeps one cache for active-branch usage totals and the latest assistant cache-hit percentage, keyed by session manager, session id, and leaf id. It clears on footer `invalidate()`. Session entries are append-only: finalized messages and usage records advance the leaf, so accounting does not need to inspect streaming message mutations.

Thinking level and context usage come from the live Extension API. Rendering receives plain display data and owns no session state or subscriptions.
