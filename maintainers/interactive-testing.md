# Interactive testing

Use [tui-test](https://github.com/microsoft/tui-test) to verify interactive Terminal UI changes without human input. It launches the real CLI inside a pseudo-terminal (`ProcessTerminal`), supporting raw input, terminal resizing, and screen capture.

## Setup

Download `tui-test` (tested with v0.1.0-beta.5) and ensure it is on your `PATH`:

```powershell
gh release download 0.1.0-beta.5 -R microsoft/tui-test -p tui-test-x86_64-pc-windows-msvc.zip -D $env:TEMP --clobber
Expand-Archive "$env:TEMP\tui-test-x86_64-pc-windows-msvc.zip" "$HOME\.local\bin" -Force
tui-test --version
```

## Quick start

Run an offline fixture session in PowerShell:

```powershell
# 1. Prepare clean artifacts directory and disable external editor unbinding
New-Item -ItemType Directory -Force .artifacts\tty\agent | Out-Null
'{ "app.editor.external": [] }' | Set-Content -Encoding utf8NoBOM .artifacts\tty\agent\keybindings.json

# 2. Launch Pi with the offline fixture provider
tui-test run --backend xtermjs --cols 100 --rows 40 --cwd "$PWD" `
  --env "PI_CODING_AGENT_DIR=$PWD\.artifacts\tty\agent" --env PI_OFFLINE=1 `
  node scripts/run-source.mjs --no-env --no-session --no-skills --no-prompt-templates `
  --extension test/fixtures/offline-provider.ts --provider offline --model fixture

# 3. Wait for readiness and clear console query noise
tui-test expect text "Offline fixture" --timeout 30000
tui-test expect text "8080/8080/8080" --timeout 10000
tui-test key press Ctrl+U
```

## Fixture test scenarios

The fixture provider (`test/fixtures/offline-provider.ts`) responds to specific prompts without network access:

| Prompt | Scenario tested |
| --- | --- |
| `tools` | Triggers a 2-second tool call (`fixture_wait`), tests settled/collapsed rendering. |
| `tools slow` | Triggers a 15-second tool call, useful for inspecting pending rail/spinner states. |
| `bg` | Hands off a bash command to background (`/tasks`), tests background cards and completion notices. |
| `long` | Streams a 45-line markdown answer to test scrolling and viewport truncation. |
| `highlight` | Streams Python code with comments and docstrings to verify syntax highlighting. |
| *other* | Returns a short answer with an expandable thinking block. |

## Driving the terminal

| Command | Action |
| --- | --- |
| `tui-test submit "<text>"` | Types string and sends `Enter`. |
| `tui-test type "<text>"` | Types string without pressing Enter. |
| `tui-test key press <Key>` | Sends keys (`Enter`, `Escape`, `Tab`, `Ctrl+O`, `Ctrl+U`, `Alt+v`, `PageUp`). |
| `tui-test expect text "<str>"` | Waits until text appears (`--timeout <ms>`). Add `--not` to wait until gone. |
| `tui-test text` | Dumps visible terminal screen (`--full` includes scrollback buffer). |
| `tui-test screenshot -o <path>` | Captures current terminal frame as PNG with rendered theme colors. |
| `tui-test resize <cols> <rows>` | Resizes terminal dimensions. |
| `tui-test close` | Closes terminal session (`tui-test close --all` cleans up all sessions). |

### Example: Tool execution lifecycle

```powershell
tui-test submit "tools slow"
tui-test expect text "Fixture tool is pending"                        # verify pending rail
tui-test screenshot -o .artifacts/tty/pending.png
tui-test expect text "Fixture tool is pending" --not --timeout 20000  # verify completion
tui-test expect text "Working" --not --timeout 30000                  # verify response settled

tui-test submit "tools"
tui-test expect text "4 earlier lines"                                # verify collapsed tool output
tui-test key press Ctrl+O
tui-test expect text "Fixture result line 1 of 14"                    # verify expanded output
```

## Platform limits and troubleshooting

- **Kitty protocol on Windows:** Windows Console drops Kitty escape sequences (`\x1b[27u`). Always launch `tui-test` with `--backend xtermjs` so plain byte sequences (`\x1b`, `\x0f`) are preserved.
- **Key modifiers:** Plain bytes cannot differentiate `Shift+Enter` from `Enter`. Use `Ctrl+J` for newlines. Alt combinations must be lowercase (`Alt+v`).
- **Color query leakage:** At startup and on `/reload`, Pi queries terminal color via OSC 10/11/4. Windows console responds immediately to DA1 and leaks unparsed color fragments (`b:8080/8080/8080` + BEL/`\x07`) into the input buffer. Always unbind `app.editor.external` in `keybindings.json` and clear with `Ctrl+U` upon startup and after `/reload`.
- **Spinner vs idle:** `wait idle` will never settle while animated spinners or loaders are active. Always wait for explicit text states via `tui-test expect text`.
