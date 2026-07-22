# statusline — fixed two-line footer

Replaces Pi's built-in footer with a fixed, color-coded two-line status display
using a balanced left/right layout. It registers no tool or command and has no
configuration file. The footer auto-enables on `session_start` in TUI mode and
clears itself on `session_shutdown`.

## What it shows

```text
DeepSeek V4 Pro (opencode-go) · xhigh          ~/Projects · main
CTX 2.1%/1.0M                    ↑13k ↓13k R440k CH99.4% $0.074
```

### Line 1 — session identity (left) · location (right)

**Left**

- **Model:** human-readable model name, falling back to the model id.
- **Provider:** the model source in parentheses, such as `(deepseek)` or
  `(opencode-go)`.
- **Effort:** the latest thinking level when the model supports reasoning and
  the level is not `off`.

**Right**

- **Working directory:** full cwd shortened against the home directory with `~`.
- **Git branch:** appended when available.

### Line 2 — context (left) · usage (right)

**Left**

- **Context:** used percentage plus context-window size. The percentage uses
  fixed semantic tiers: accent normally, warning above 70%, error above 90%.

**Right**

- `↑` cumulative input tokens.
- `↓` cumulative output tokens.
- `R` cumulative cache-read tokens.
- `W` cumulative cache-write tokens, omitted when zero.
- `CH` cache-hit percentage for the latest assistant request, calculated as
  `cacheRead / (input + cacheRead + cacheWrite)` and shown only when that
  request used cache.
- `$` cumulative cost; `(sub)` is appended when the current model uses an OAuth
  subscription.

**Middle (optional)**

- Extension status text from `ctx.ui.setStatus()` is sorted by key and centered
  in the gap between context and usage when space permits; otherwise it is
  dropped so CTX and usage stay readable. Plain text is muted; strings that
  already carry ANSI color are left unchanged.

Zero-value usage fields are omitted. Before the first assistant response, the
right side of line 2 is empty (or holds extension status only).

## Narrow-width drop order

When the terminal is too narrow for the full layout:

**Line 1** (first drop → last):

1. Drop the git branch.
2. Keep the full path alone on the right.
3. Shorten the path to `~/basename` (or bare basename).
4. Drop the provider parentheses.
5. Truncate the remaining left/right text.

**Line 2** (first drop → last):

1. Drop extension status from the middle gap.
2. Drop `W`, then `R`, from the usage cluster.
3. Truncate CTX / remaining usage as a last resort.

## Layout and colors

- Model name uses `toolTitle` and bold; provider uses `muted`.
- Effort uses Pi's thinking-level color.
- Context uses `accent`, `warning`, or `error` according to the fixed thresholds.
- Working directory uses `success`; Git branch uses `accent`.
- Usage statistics use `dim`; extension status text uses `muted`.
- Each line left-aligns its primary cluster and right-aligns the secondary
  cluster, filling the gap with spaces so wide terminals stay balanced.

Pi does not expose auto-compaction state to extension footer factories, so the
native `(auto)` marker is intentionally not reproduced.

## Migration

The previous `/statusline` command and `~/.pi/agent/pi-config/statusline.json`
configuration are no longer used. An existing config file is left untouched and
may be removed manually.

## Limits

- Auto-enables only in TUI mode on `session_start`; RPC and print modes show the upstream footer.
- The native `(auto)` compaction marker is not reproduced because Pi does not expose that state to extensions.

## Implementation notes

Footer paint is hot (every TUI render). The extension caches:

- **Branch path** by current leaf id.
- **Branch stats** (thinking level + cumulative usage) by branch length, leaf entry identity, and a leaf usage fingerprint.

Both caches clear on footer `invalidate()`.

**Files:** `index.ts` — footer lifecycle, formatting, usage aggregation, and responsive two-line left/right layout.
