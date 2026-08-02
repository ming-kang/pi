# Biu — project development workflow

Biu is a simple, structured development workflow for the interactive TUI: `/biu` switches Biu Mode on, and inside the mode `/biu` opens its menu. One project cycle moves through soft stages — **plan** (clarify requirements into an approved `SPEC.md`), an **optional decompose** step (break a complex SPEC into task handoffs; simple SPECs are implemented directly), **execute** (implement, one task at a time when tasks exist), and **archive** (summarize and close the cycle).

There is no state machine and no workflow tool. Workflow state lives in the frontmatter of the workspace Markdown files — the SPEC's `status: draft|ready`, each task's `status: ready|in_progress|completed` and `depends_on` — and the extension derives a read-only snapshot from them each turn. The model edits these files with the normal file tools through the `biu://` scheme.

## Command

| Command | Behavior |
|---|---|
| `/biu` | When the mode is off, turn it on (no agent turn is triggered); when it is on, open the Biu menu |

`/biu` accepts no arguments. Turning the mode on with no prior cycle leaves the workflow at the plan stage — describe what you want to build in your next message and the interview starts from there. With an existing cycle, the mode resumes at the stage derived from the workspace files.

The menu keeps only the actions needed to operate the workflow:

- **Continue · stage** — send a kickoff message (collapsed to one line; expandable with the standard expand key) that starts a turn continuing the current stage.
- **Archive cycle** — deterministically move `SPEC.md`, `Summary.md`, and `tasks/` into `archived/YYYY-MM-DD-<shortname>/`. Requires an existing, model-drafted and user-confirmed `Summary.md`; archiving with unfinished tasks asks for confirmation first. The shortname is derived from the SPEC's `title` frontmatter (a dialog asks for one when it is missing). On failure, already-moved files are rolled back.
- **Exit Biu Mode** — turn the mode off. Workflow files are kept.

A subtitle summarizes the current stage; while the mode is on, the footer keeps the marker `Biu · execute 2/5` (warning-colored when workspace files have problems, such as malformed frontmatter).

Biu Mode is TUI-only. RPC, JSON, and print sessions do not enable it, inject its resident prompt, or open its menu. Opening the same branch later in the TUI restores its recorded enabled flag.

## Storage and the `biu://` scheme

Biu artifacts live under the normal Pi agent directory, grouped by working directory with the same path encoding used for sessions:

```text
~/.pi/agent/biu/
└── --encoded-working-directory--/
    ├── SPEC.md                    # frontmatter: title, status, execution, baseline_commit
    ├── Summary.md                 # frontmatter: title, head_commit; temporary while archiving
    ├── tasks/
    │   └── TASK-<short-name>.md   # frontmatter: title, status, depends_on
    └── archived/
        └── YYYY-MM-DD-shortname/
            ├── SPEC.md
            ├── Summary.md
            └── tasks/
```

`PI_CODING_AGENT_DIR` is respected. Biu never creates, reads, or migrates a project-local `.biu` directory, and it does not modify `.gitignore`.

The model never sees or uses these real paths. A `tool_call` hook rewrites `biu://` paths — `biu://SPEC.md`, `biu://tasks/TASK-api.md`, `biu://Summary.md` — to the workspace of the current working directory before `read`, `write`, `edit`, `grep`, `find`, and `ls` execute. The session records keep the original `biu://` arguments, so the transcript and TUI show the short stable paths while execution uses the resolved ones. Paths that escape the workspace (`..` segments, rooted paths) are blocked. The scheme resolves regardless of whether Biu Mode is on; the mode only controls prompting, the statusline, and the menu.

## Prompting

While the mode is on, the full Biu block is injected into the system prompt each turn: the `biu://` conventions, a JSON snapshot of the workspace (derived stage, SPEC metadata, task statuses and focus, detected problems), and the playbook for the derived stage, including the relevant Markdown templates. At the execute stage the playbook follows the SPEC's `execution` field — `direct` implements straight against the SPEC, `tasks` decomposes into task files first, and a SPEC without the field falls back to a combined playbook that asks to record the choice. There is nothing to fetch on demand — the workspace files are the state, and the snapshot always reflects them.

Stage transitions are file edits, with one guarded exception: flipping the SPEC's `status` to `ready` opens an approval dialog. Approving lets the write land and the cycle move on to execute; declining blocks the write and hands your feedback to the model as the tool result, so it revises the SPEC and asks again. During planning the model also records the agreed execution path in the frontmatter (`execution: direct` by default; `tasks` when the work splits into independently verifiable chunks). Writing task files opts into decomposition, task frontmatter tracks execution, and writing `Summary.md` (or completing every task) enters archive. Moving backward — for example reopening the SPEC as `draft` when execution reveals a gap, or switching `execution` when the size estimate was wrong — is just another frontmatter edit.

## Lifecycle

The enabled flag is stored as a branch-aware custom session entry. In the TUI, `session_start` and `session_tree` replay the latest flag, so `/reload`, resume, fork, and tree navigation restore the mode. Non-TUI sessions leave that flag untouched but keep Biu inactive. The statusline refreshes whenever a `write` or `edit` lands inside the workspace.

Biu artifacts are project-global rather than conversation-branch snapshots: navigating `/tree` changes the enabled flag with the branch, but workflow files do not roll back.

## Limits

- The snapshot lists at most 100 task files; additional files are reported as a problem instead of being silently ignored.
- Malformed frontmatter never blocks the workflow: the affected file degrades to an `unknown` status and the problem is surfaced to the model and in the statusline.
- Concurrent writers in multiple Pi processes are not coordinated. Use one active Biu writer per project.
