# Shell paths

On Windows, the `bash` tool runs Git Bash, MSYS2, or Cygwin, which name files through their own mount table. A model that works in `/tmp/build` with `bash` and then calls `read /tmp/build/log.txt` would otherwise reach `C:\tmp\build\log.txt` on the current drive instead of the directory bash used.

This extension resolves such paths for the `read`, `write`, `edit`, `ls`, `grep`, and `find` tools the way bash does:

| Path from bash | Resolves to (Git for Windows defaults) |
|---|---|
| `/tmp/build/log.txt` | `C:\Users\<you>\AppData\Local\Temp\build\log.txt` |
| `/usr/bin/bash.exe` | `C:\Program Files\Git\usr\bin\bash.exe` |
| `/etc/gitconfig` | `C:\Program Files\Git\etc\gitconfig` |

The first such call reads the mount table from the configured shell (`shellPath` or the detected bash) with `mount`, so custom `fstab` entries and non-default installations resolve correctly. Bash maps `/tmp` to the user's temp directory even when Pi runs with a different `TEMP`.

Drive paths such as `/c/Users/...`, `/cygdrive/c/...`, and `/mnt/c/...` work without this extension. Windows paths, relative paths, UNC paths, and paths on other platforms are left unchanged. Legacy WSL bash (`System32\bash.exe`) is skipped because its mounts live inside the Linux filesystem.

Disable `builtin:shell-paths` to resolve these paths against the current drive root instead.
