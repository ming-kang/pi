# Windows Setup

Pi uses Git Bash by default on Windows. Checked locations (in order):

1. Custom path from `~/.pi/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

Pi resolves Bash in this order:

1. `shellPath` from `~/.pi/agent/settings.json`
2. Git Bash at `%ProgramFiles%\Git\bin\bash.exe`
3. Git Bash at `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `bash.exe` on `PATH`, including Cygwin, MSYS2, or legacy WSL Bash

Start Pi and enter this command to verify the shell:

```text
!echo "$BASH_VERSION"
```

If Pi cannot find Bash, it reports the locations it checked. Install Git for Windows, set `shellPath`, or add Bash to `PATH`.

## Choose a terminal

Windows terminals run pi through a console host (conhost). Some bundle an up-to-date copy; others use the older one built into Windows, which has bugs that affect pi.

We recommend [Windows Terminal](https://aka.ms/terminal). It always ships an up-to-date conhost, and pi is best tested with it.

Last updated: October 2026.

| Terminal | Conhost | Status |
|---|---|---|
| [Windows Terminal](https://aka.ms/terminal) | Bundled, current | Recommended |
| [VS Code](https://code.visualstudio.com), [Tabby](https://tabby.sh), [WezTerm](https://wezterm.org) nightly | Bundled, current | Works |
| [Alacritty](https://alacritty.org) | Built-in, unless `conpty.dll` and `OpenConsole.exe` from Windows Terminal are next to `alacritty.exe` | Works only with those files |
| WezTerm 20240203 and older | Bundled, old | [Known issues](#known-issues) |
| Classic console (`cmd.exe` or PowerShell without Windows Terminal), mintty (Git Bash), ConEmu, Cmder, [Hyper](https://hyper.is), Windows OpenSSH | Built-in | [Known issues](#known-issues) |

See [Windows Terminal](terminal-setup.md#windows-terminal) to configure `Shift+Enter` and `Alt+Enter`.

## PowerShell Tool

The optional `powershell` tool runs commands through `pwsh.exe` when available, otherwise Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

PowerShell discovery checks these locations in order:

1. `pwsh.exe` on `PATH`
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`
3. `powershell.exe` on `PATH`
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

Use `defaultTools` to replace the model-facing `bash` tool:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Or enable both while comparing behavior:

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write"]
}
```

The `!` and `!!` editor commands still use Bash.

## WSL

WSL path conversion on Windows and extra Git branch polling in WSL recognize `/mnt/<drive>`, not custom mount roots.

When using the legacy WSL `bash.exe` launcher from Windows, Pi sends commands over stdin to avoid command-line quoting problems.

## Custom Bash Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

`"defaultTools": ["-bash", "+powershell"]` replaces Bash while preserving other configured default tools.

## Known issues

These issues come from conhost. Microsoft has fixed them in its source, but has not said when the built-in conhost will get the fixes.

| Issue | Affects | Remedy |
|---|---|---|
| Switching from fullscreen to regular mode, or `Ctrl+G` from fullscreen, crashes the session ([#9186](https://github.com/earendil-works/pi/issues/9186), [microsoft/terminal#17515](https://github.com/microsoft/terminal/issues/17515)) | Built-in conhost | Use a terminal with a current conhost, or start pi with `--tui-mode regular` |
| Text such as `;0;rgb:0000/0000/0000` appears in the prompt, and BEL opens the external editor ([#10256](https://github.com/earendil-works/pi/issues/10256)) | Built-in conhost behind another terminal: mintty, Windows OpenSSH | Use a terminal with a current conhost |
| Fragments such as `79` or `55` appear in the prompt ([#10717](https://github.com/earendil-works/pi/issues/10717)) | WezTerm 20240203 | Use WezTerm nightly |
| In regular mode, each keystroke redraws the input line on a new row ([#6300](https://github.com/earendil-works/pi/issues/6300)) | Built-in conhost, classic console | Use fullscreen mode (the default), or a terminal with a current conhost |
