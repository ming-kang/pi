# Interactive testing

Use [tui-test](https://github.com/microsoft/tui-test) to check interactive changes without a person at the keyboard. It runs the real CLI in a pseudo-terminal, a terminal device that a program creates, so Pi takes the same `ProcessTerminal` path as in a terminal window: raw input, keyboard negotiation, resizing, and screen updates. Commands then send keys and read the screen as text or as a PNG screenshot. Automated tests keep using the in-process `VirtualTerminal`.

## Install

Put tui-test 0.1.0-beta.5 in a directory on `PATH`, such as `~/.local/bin`:

```powershell
gh release download 0.1.0-beta.5 -R microsoft/tui-test -p tui-test-x86_64-pc-windows-msvc.zip -D $env:TEMP --clobber
Expand-Archive "$env:TEMP\tui-test-x86_64-pc-windows-msvc.zip" "$HOME\.local\bin" -Force
tui-test --version
```

This page was verified on Windows; other platforms use the matching asset from the same release. tui-test is in beta and its commands may change, so re-check this page before moving to another version.

## Start Pi

Run from the repository root in PowerShell:

```powershell
tui-test run --backend xtermjs --cols 100 --rows 30 --cwd "$PWD" `
  --env "PI_CODING_AGENT_DIR=$PWD\.artifacts\tty\agent" --env PI_OFFLINE=1 `
  node scripts/run-source.mjs --no-env --no-session --no-skills --no-prompt-templates `
  --extension test/fixtures/offline-provider.ts --provider offline --model fixture
tui-test expect text "Offline fixture" --timeout 30000
```

This runs the source checkout like `npm run dev`, offline, without saving a session, and without provider credentials or your own settings, skills, and prompt templates. Startup takes about 15 seconds. The agent directory and screenshots stay in the ignored `.artifacts/tty/`; delete it for a clean start. Always pass `--backend xtermjs` (see [Limits](#limits)).

The fixture provider in `test/fixtures/offline-provider.ts` answers without network access:

| Prompt | Result |
| --- | --- |
| `tools` | Calls the `fixture_wait` tool for 2 seconds, then answers. |
| `tools slow` | Same with a 15-second tool call, long enough to inspect the pending state. |
| `long` | Streams a 45-line answer. |
| Anything else | A short answer with a thinking block. |

States the fixture cannot create, such as background tasks for `/bg`, need a fixture extension: put it under `.artifacts/<topic>/` and add `--extension <file>`.

## Drive and inspect

| Command | Effect |
| --- | --- |
| `tui-test submit "/provider"` | Type text and press Enter. |
| `tui-test type "abc"` | Type text only. |
| `tui-test key press Escape` | Press keys such as `Enter`, `Escape`, `Tab`, `Up`, `PageUp`, `Ctrl+O`, `Alt+v`, or `F2`. |
| `tui-test expect text "Session Tree" --timeout 5000` | Wait until the text is visible; add `--not` to wait until it is gone. |
| `tui-test text` | Print the visible screen; `--full` includes scrollback. |
| `tui-test screenshot -o .artifacts/tty/provider.png` | Save a PNG with theme colors for checking layout and color. |
| `tui-test resize 72 22` | Resize the terminal. |
| `tui-test close` | Stop Pi and end the session. |

The session persists between commands until `close`. Pass `--session <name>` on every command to run several sessions at once, and use `tui-test close --all` to remove leftovers.

To check a state change, wait for text that only the new state shows, then for the old state's text to disappear. Earlier transcript content stays on screen and can satisfy a loose match:

```powershell
tui-test submit "tools slow"
tui-test expect text "Fixture tool is pending"                        # pending
tui-test screenshot -o .artifacts/tty/pending.png
tui-test expect text "Fixture tool is pending" --not --timeout 20000  # settled
tui-test key press Ctrl+O                                             # expanded or collapsed
tui-test expect text "Working" --not --timeout 30000                  # run finished
```

The answer keeps streaming after the tool settles, and Pi refuses `/reload` until the run finishes, so wait for the `Working` line to disappear first. `/reload` and `/tree` are ordinary commands: `submit "/tree"`, check the screen, then `key press Escape`.

## Limits

- The default backend accepts Pi's request to enable the Kitty keyboard protocol and then encodes keys such as `Escape` as `\x1b[27u`. The Windows console layer between them drops those sequences, so `Escape`, `Ctrl+C`, and `Ctrl+O` silently do nothing. The xterm.js backend sends plain bytes (`\x1b`, `\x03`, `\x0f`) that arrive intact.
- Plain bytes cannot express `Shift+Enter`, `Ctrl+Enter` (both arrive as Enter), or `Ctrl+Shift+<letter>`. Use `Ctrl+J` for a newline. Write Alt keys in lowercase (`Alt+v`); `Alt+V` adds Shift. This setup therefore checks Pi's non-Kitty input path; `VirtualTerminal` tests cover Kitty mode.
- `wait idle` never settles while a spinner animates; wait for text instead.
