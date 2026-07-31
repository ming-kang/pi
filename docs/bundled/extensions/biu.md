# Biu — project development workflow

Biu is a structured development workflow modeled after a mode toggle: `/biu` switches Biu Mode on, and inside the mode `/biu` opens the management menu. One project cycle moves through four stages — **interview** (clarify requirements into `SPEC.md`), **decompose** (break the ready SPEC into task handoffs), **execute** (implement tasks one at a time), and **archive** (summarize and close the cycle).

Workflow state lives in a small JSON file and changes only through the `biu` tool; the Markdown artifacts carry content only. Nothing is inferred by parsing Markdown.

## Command

| Command | Behavior |
|---|---|
| `/biu` | When the mode is off, turn it on (no agent turn is triggered); when it is on, open the Biu menu |

`/biu` accepts no arguments. Turning the mode on with no prior cycle leaves the workflow at the interview stage — describe what you want to build in your next message and the interview starts from there. With an existing cycle, the mode resumes at the recorded stage.

The menu offers:

- **Continue · stage** — send a kickoff message (collapsed to one line; expandable with the standard expand key) that starts a turn continuing the current stage.
- **Show status** — workspace path, SPEC status, and task counts.
- **Switch stage…** — move the workflow to another stage. Forward moves are validated; backward moves are free.
- **Exit Biu Mode** — turn the mode off. Workflow files are kept.

While the mode is on, the footer shows a compact marker such as `Biu · execute 2/5`.

## Storage

Biu state lives under the normal Pi agent directory, grouped by working directory with the same path encoding used for sessions:

```text
~/.pi/agent/biu/
└── --encoded-working-directory--/
    ├── biu.json                   # workflow state (the single source of truth)
    ├── SPEC.md                    # content only
    ├── Summary.md                 # temporary while archiving
    ├── tasks/
    │   └── TASK-<short-name>.md
    └── archived/
        └── YYYY-MM-DD-shortname/
            ├── SPEC.md
            ├── Summary.md
            └── tasks/
```

`PI_CODING_AGENT_DIR` is respected. Biu never creates, reads, or migrates a project-local `.biu` directory, and it does not modify `.gitignore`.

`biu.json` records the current stage, SPEC metadata (`draft`/`ready`, title, baseline commit), and the task list with statuses (`ready`/`in_progress`/`completed`) and dependencies. It is written atomically and only by the `biu` tool. Session history stores only whether Biu Mode is enabled.

## The `biu` tool

The tool is added to the active tool set while the mode is on and removed when it is off. Five actions:

| Action | Purpose |
|---|---|
| `get` | Load the workflow snapshot, workspace paths, and the current stage's full instructions and templates |
| `spec` | Update SPEC metadata: title, baseline commit, `draft`/`ready` status |
| `task` | Add, update, or remove a task entry (id, title, status, dependencies) |
| `stage` | Move between stages; forward moves are validated (decompose needs a ready SPEC, execute needs registered tasks) |
| `archive` | Atomically move `SPEC.md`, `Summary.md`, and `tasks/` into `archived/YYYY-MM-DD-<shortname>/` and reset the cycle |

Validation lives in the tool, not in Markdown parsing: task ids use the portable `TASK-` form, dependencies must resolve and stay acyclic, new tasks start `ready`, and archiving with unfinished tasks requires an explicit confirmation flag after the user's decision. Acceptance-criteria coverage is checked by the model during decompose, not enforced mechanically.

## Prompting

Only a short resident block is injected into the system prompt while the mode is on (current stage plus a pointer to the `biu` tool). The full stage playbook — interview rules, decomposition checks, execution discipline, archive steps, and the SPEC/TASK/Summary templates — is returned by `get` on demand, so long conversations stay grounded without repeating instructions every turn.

Stage changes are conversational: the model advances (or retreats) via the `stage` action after the user agrees, and the menu offers the same transition as a manual fallback.

## Lifecycle

The enabled flag is stored as a branch-aware custom session entry. `session_start` and `session_tree` replay the latest flag, so `/reload`, resume, fork, and tree navigation restore the mode and the tool's visibility. The statusline refreshes after each `biu` tool call rather than by rescanning files every turn.

Biu artifacts are project-global rather than conversation-branch snapshots: navigating `/tree` changes the enabled flag with the branch, but workflow files do not roll back.

## Limits

- At most 200 task entries per cycle.
- Concurrent writers in multiple Pi processes are not coordinated. Use one active Biu writer per project.
