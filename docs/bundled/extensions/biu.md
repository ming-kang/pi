# Biu — project development workflow

Biu adds `/biu`, a file-first workflow that carries one project cycle through interview, decomposition, execution, and archive. It infers the current stage from Markdown artifacts, injects only that stage's guidance into the agent prompt, and publishes a compact phase marker through `ctx.ui.setStatus()`.

## Commands

| Command | Behavior |
|---|---|
| `/biu` | Enter or resume Biu Mode, infer the stage, and immediately start the corresponding agent turn |
| `/biu status` | Show the inferred stage, workspace path, task counts, active or next task, and bounded diagnostics |
| `/biu off` | Leave Biu Mode without changing workflow files |

Calling `/biu` again while the mode is active resumes it; it does not toggle the mode off.

## Storage

Biu state lives under the normal Pi agent directory and is grouped by working directory with the same path encoding used for sessions:

```text
~/.pi/agent/biu/
└── --encoded-working-directory--/
    ├── SPEC.md
    ├── Summary.md                 # temporary while archiving
    ├── tasks/
    │   └── TASK-<short-name>.md
    └── archived/
        └── YYYY-MM-DD-NN/
            ├── SPEC.md
            ├── Summary.md
            └── tasks/
```

`PI_CODING_AGENT_DIR` is respected. Biu never creates, reads, or migrates a project-local `.biu` directory, and it does not modify `.gitignore`.

The Markdown files are the authoritative workflow state. Session history stores only whether Biu Mode is enabled; it does not duplicate the inferred stage, SPEC, or task state.

## Stages

| Stage | Inference |
|---|---|
| `interview` | `SPEC.md` is absent or has `status: draft` |
| `decompose` | SPEC is ready, but no complete valid task set covers every acceptance criterion |
| `execute` | The ready SPEC and task graph are valid and at least one task is ready or in progress |
| `archive` | Every task is completed, or a root `Summary.md` shows that archive review is underway |
| `repair` | Frontmatter, AC coverage, task identity, dependency, or status invariants are inconsistent |

A ready SPEC must have a title, an `Open Questions` section with no unchecked items, and at least one stable `AC<n>:` acceptance criterion. Task ids use the portable form `TASK-` plus 1–80 ASCII letters, digits, dots, underscores, or hyphens. Task files use `ready`, `in_progress`, or `completed`, must reference known AC ids, and form an acyclic `depends_on` graph. At most one task may be `in_progress`.

The inferred stage is the default next action. An explicit user instruction may revisit or skip a stage, but approval and safety gates still apply.

## Stage behavior

- **Interview:** investigate code facts directly, ask one product decision at a time, update the draft SPEC after each substantive answer, and require explicit approval before `status: ready`.
- **Decompose:** explore reuse opportunities, present the proposed task graph and AC mapping for approval, then write `TASK-*.md` handoffs one at a time.
- **Execute:** continue the active task or select the first unblocked ready task, record decisions and notes incrementally, and mark it completed only after verification passes. One task is executed at a time by default.
- **Archive:** review unfinished work, draft and confirm `Summary.md`, then move the cycle into the first unused `archived/YYYY-MM-DD-NN/` directory.
- **Repair:** preserve content and stable ids while fixing only the reported contract violations.

Biu uses Pi's normal tools. It does not replace or disable tools, register a model-facing workflow tool, intercept compaction, or maintain a second task database.

## Lifecycle

The enabled flag is stored as a branch-aware custom session entry. `session_start` and `session_tree` replay the latest flag, so `/reload`, resume, fork, and tree navigation restore the appropriate mode marker. Before each agent run Biu rescans the workspace and injects bounded stage context; after the run settles it rescans and refreshes the statusline.

Biu artifacts are project-global rather than conversation-branch snapshots. Navigating `/tree` changes the conversation branch and Biu enabled flag, but it does not roll workflow files back. The current files continue to win.

## Limits

- SPEC and active TASK files are limited to 256 KiB each.
- At most 200 active `TASK-*.md` files are scanned.
- Prompt diagnostics, task titles, and AC lists are bounded; complete artifacts are read on demand rather than embedded in every prompt.
- Concurrent writers in multiple Pi processes are not coordinated. Use one active Biu writer per project.
