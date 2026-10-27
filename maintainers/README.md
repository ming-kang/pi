# Maintainer guide

Repository-only guidance excluded from npm. Start with [AGENTS.md](../AGENTS.md).

## Ownership map

| Document | Owns |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Non-negotiable repository boundaries and implementation/verification requirements. |
| [Architecture](architecture.md) | Dependency scope, capability placement, subsystem ownership, and durable reasons for local behavior. |
| [Dependency maintenance](dependencies.md) | Installation, consistency checks, age exceptions, and lockfile acknowledgements. |
| [Upstream synchronization](upstream.md) | Baseline, ledger maintenance (`concerns.json`), and the `npm run sync` runbook. |
| [Release](release.md) | Distribution versioning, `npm run release`, publication, and tag recovery. |
| [Interactive testing](interactive-testing.md) | Driving the real interactive CLI with `tui-test` to verify terminal UI changes. |
| [Development](../docs/development.md) | Running, building, and testing a checkout. |

Link to the owning document rather than duplicating rules. Release-specific adoption decisions belong in the `feat: sync upstream` commit message.

## Quick notes

- **Commit hook:** Runs format, checks, and the upstream ledger (`concerns.json`). A missing baseline tree requires fetching the exact upstream tag recorded in `upstream.json`.
- **TUI debug output:** The hidden `/debug` command writes rendered TUI lines and recent model messages to `~/.pi/agent/pi-debug.log`.
