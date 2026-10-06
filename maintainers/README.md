# Maintainer guide

These repository-only notes are excluded from npm. Start with [AGENTS.md](../AGENTS.md).

## Where information belongs

| Document | Owns |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Non-negotiable repository boundaries and implementation/verification requirements. |
| [Architecture](architecture.md) | Dependency scope, subsystem ownership, and durable reasons for local behavior. |
| [Dependency maintenance](dependencies.md) | Installation, consistency checks, npm age exceptions, and lockfile acknowledgement. |
| [Upstream synchronization](upstream.md) | Baseline/ledger use and `npm run sync`. |
| [Release](release.md) | Distribution versioning, `npm run release`, publication, and release tags. |
| [Interactive testing](interactive-testing.md) | Driving the real interactive CLI with tui-test to verify terminal UI changes. |
| [Development](../docs/development.md) | Running, building, and testing a checkout. |

Link to the owner of a rule rather than maintaining another copy. Release-specific adoption decisions belong in the `feat: sync upstream` commit body. Update `concerns.json` with the owning concern and covering tests when local behavior changes.

## Daily work

Use the development commands and dependency procedures linked above. The commit hook checks the upstream ledger as well as repository checks. A missing baseline tree requires fetching the exact tag in `upstream.json`; the hook does not fetch or change refs.

The hidden `/debug` command writes rendered TUI lines and recent model messages to `~/.pi/agent/pi-debug.log`.
