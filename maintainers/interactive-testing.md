# Interactive testing

Verify Terminal UI changes by driving the real CLI in a pseudo-terminal with [tui-test](https://github.com/microsoft/tui-test). Commands below are for pwsh 7.

## Install

Install the latest release into a directory on `PATH`:

```powershell
gh release download -R microsoft/tui-test -p tui-test-x86_64-pc-windows-msvc.zip -D $env:TEMP --clobber
Expand-Archive "$env:TEMP\tui-test-x86_64-pc-windows-msvc.zip" "$HOME\.local\bin" -Force
tui-test --version
```

To upgrade, run `tui-test close --all` first (a running session daemon locks the executable), then repeat the install.

## Launch Pi

```powershell
# Isolated agent dir; unbinding the external editor is required on Windows (see Troubleshooting)
New-Item -ItemType Directory -Force .artifacts\tty\agent | Out-Null
'{ "app.editor.external": [] }' | Set-Content -Encoding utf8NoBOM .artifacts\tty\agent\keybindings.json

tui-test run --backend xtermjs --cols 100 --rows 40 --cwd "$PWD" `
  --env "PI_CODING_AGENT_DIR=$PWD\.artifacts\tty\agent" --env PI_OFFLINE=1 `
  node scripts/run-source.mjs --no-env --no-session --no-skills --no-prompt-templates `
  --extension test/fixtures/offline-provider.ts --provider offline --model fixture

tui-test expect text "Offline fixture" --timeout 30000
tui-test expect text "8080/8080/8080" --timeout 10000   # wait for the startup color-query leak
tui-test key press Ctrl+U                                # then clear it from the editor
```

Pi starts in fullscreen mode. Append `--tui-mode regular` to test the layout that uses the terminal's normal scrollback. End the session with `tui-test close`.

## Fixture prompts

The offline provider (`test/fixtures/offline-provider.ts`) answers these prompts without network access:

| Prompt | Scenario |
| --- | --- |
| `agent` | Delegates to the built-in `Agent`; the child reads `README.md` and returns a report for Transcript and `/tasks` checks. `agent slow` keeps the report streaming; `agent background slow` keeps a detached Agent live in `/tasks`. |
| `tools` | 2-second tool call (`fixture_wait`); settled and collapsed rendering. |
| `tools slow` | 15-second tool call; pending rail and spinner states. |
| `bg` | Bash command handed off to the background; `/tasks` cards and completion notices. |
| `long` | 45-line markdown answer; scrolling and viewport truncation. |
| `highlight` | Python code with comments and docstrings; syntax highlighting. |
| *other* | Short answer with an expandable thinking block. |

## Commands

`tui-test usage` prints the full cheatsheet. The ones used most here:

| Command | Action |
| --- | --- |
| `submit "<text>"` / `type "<text>"` | Type text, with or without `Enter`. |
| `key press <Key>` | Send keys: `Enter`, `Escape`, `Tab`, `Ctrl+O`, `Ctrl+U`, `Alt+v`, `PageUp`. |
| `expect text "<str>" [--not] [--timeout <ms>]` | Wait until text appears (or disappears); exits 1 on timeout. |
| `text [--full]` | Print the visible screen; `--full` adds scrollback. |
| `screenshot -o <file>.png` | Capture the screen with theme colors. |
| `scroll up\|down [<lines>]`, `scroll top\|bottom` | Move through native scrollback (regular mode); `get viewport` reports the offset. |
| `resize <cols> <rows>` | Resize the terminal. |
| `monitor` | Watch the session live from another terminal. |

Fullscreen mode draws its transcript on the alternate screen, so scroll it with Pi keys (`PageUp`/`PageDown`) instead of `tui-test scroll`.

Example: tool execution lifecycle.

```powershell
tui-test submit "tools slow"
tui-test expect text "Fixture tool is pending"                        # pending rail
tui-test screenshot -o .artifacts/tty/pending.png
tui-test expect text "Fixture tool is pending" --not --timeout 20000  # tool finished
tui-test expect text "Working" --not --timeout 30000                  # response settled

tui-test submit "tools"
tui-test expect text "4 earlier lines"                                # collapsed output
tui-test key press Ctrl+O
tui-test expect text "Fixture result line 1 of 14"                    # expanded output
```

## Troubleshooting

- **Always pass `--backend xtermjs` on Windows.** Windows Console drops Kitty keyboard sequences (`\x1b[27u`); the xterm.js backend preserves plain bytes (`\x1b`, `\x0f`).
- **Color-query leak.** At startup and on `/reload`, Windows Console answers Pi's DA1 query immediately and leaks unparsed OSC 10/11/4 color fragments (`b:8080/8080/8080` plus BEL) into the editor. BEL is `Ctrl+G`, the external editor key, hence the unbinding; clear the rest with `Ctrl+U`.
- **Key limits.** Plain bytes cannot distinguish `Shift+Enter` from `Enter`; use `Ctrl+J` for a newline. Write Alt combinations in lowercase (`Alt+v`).
- **Spinners block `wait idle`.** It never settles while an animation runs; wait for explicit text with `expect text`.
