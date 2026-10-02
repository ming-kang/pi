# question — structured user questions

Adds a `question` tool for asking one to four multiple-choice questions when the agent needs a user decision. A Pi-native take on AskUserQuestion: a lightweight custom dialog with concise transcript summaries and a bounded model-facing result.

## Behavior

- Each option requires a concise description of its consequence or trade-off. Questions, headers, option labels, descriptions, and provided previews must contain visible non-whitespace text and stay within their input-length limits; punctuation such as a trailing question mark is guidance, not a validation requirement.
- Question tool calls execute sequentially, so two calls in one tool batch cannot open competing blocking dialogs.
- A single single-select question submits as soon as the user selects an option.
- A multi-question flow advances after each single-select answer; multi-select uses `Space` to toggle choices and Enter to continue. Once every question is answered, a **Review answers** view requires explicit submission.
- Options are numbered; pressing `1`–`9` jumps to the matching option — selecting it in single-select, toggling it in multi-select. The custom-answer row's number opens its input.
- `←` / `→` switch between adjacent questions without wrapping. The tab bar uses the question headers and marks answered questions and the Review state. The question body displays only the question text, without repeating its header.
- `Chat about this` is available after the choices. It returns a `needs_clarification` outcome so the model explains or reformulates instead of treating the user as having declined.
- `Type something` is appended automatically for custom answers. Authored options may not use reserved labels (`Other`, `Type something`, the legacy `Type something.`, or `Chat about this`); the comparison is case-insensitive and ignores surrounding whitespace.
- `Tab` opens a note editor for the focused option; in multi-select, the option must be selected first. In single-select it also selects the option, and cancelling the note editor with `Esc` restores the previous selection. On the custom-answer row, it opens custom-answer input.
- Multi-select custom answers stay on the `Type something` row, are selected when saved, and can be toggled with `Space` without losing text. Enter on that row opens the input while no custom answer exists yet.
- Options form a compact list with one row per choice. The focused row is highlighted; its full label, description, saved note, and optional Markdown `preview` appear in a separate reading area. At 72 columns and up the areas sit side by side: the list fits the longest option label, with a 24-column minimum and a cap of half the usable width; the remaining width goes to details. Its width stays stable when moving focus or saving answers. Narrower terminals stack the details under a window of choices. Long labels are shortened only in the list, and remain readable in full in the details.
- `Alt+↑` / `Alt+↓` page through the details without changing the focused choice. A clipped reading area shows the visible line range and total, such as `8–15/36`, plus the configured paging keys. Changing choices starts the new details at the top; resizing reflows the content and keeps its end visible if you were already there. Rebind these actions with `app.question.pageUp` / `app.question.pageDown`. Plain Page Up/Down continue to scroll the transcript in fullscreen mode. Previews on multi-select questions are rejected with a `preview_multiselect` error.
- The dialog is available only in TUI mode. RPC, JSON, and print calls return a structured `no_ui` error rather than attempting a custom component.
- The dialog takes at most half of the terminal height (16 rows minimum, capped by the terminal height) so the assistant reply above it stays readable. The tab bar, the question, `Chat about this`, and the key hints stay pinned when space permits. The options scroll as whole rows, with `↑ N more options` and `↓ N more options` hints on the sides that have more. Narrow layouts reserve space for reading details while keeping the focused choice visible. Notes and custom-answer input follow the cursor when clipped. Long Review answers can be scrolled with the configured up/down bindings while Enter still submits and Esc returns to editing.
- Aborting the turn closes the dialog and resolves the call as cancelled with the answers given so far.

## Result contract

`details` preserves structured state for rendering and session history:

```ts
{
  answers,
  outcome: "answered" | "cancelled" | "needs_clarification" | "error",
  cancelled,
  error?,
  message?, // human-readable rendering text for error outcomes
}
```

Only `content` reaches the model. Successful results are numbered, clearly identify single/custom/multi answers, retain notes, and state when a preview was selected without echoing its full source. Cancelling — via `Esc` or a turn abort — lists any answers already given as partial answers alongside the decline message. Model-facing output is capped at 12,000 characters. To fit, only user-written text — answers, selections, and notes — is shortened: short texts stay whole, long ones are cut evenly, keeping their start and end around a `…N chars truncated…` marker, and the result asks the model to follow up on the omitted part. Every question, header, and closing instruction is always kept. Notes and custom answers are capped at 4,000 characters in the dialog. Only `outcome: "error"` is mapped to Pi's protocol-level tool error flag; answered, cancelled, and clarification outcomes remain normal results.

The transcript uses a private `renderCall` / `renderResult` only to replace raw question JSON and model-oriented result text with concise user summaries. The collapsed call keeps a bounded header; expanding lists every question in full and marks multi-select prompts. Cancelled and clarification outcomes report `answered N of M`, and the expanded result preserves partial decisions and notes. Human-readable validation errors are shown instead of machine codes, while older or malformed session details fall back defensively to bounded content. Schema-level argument failures show only the first bounded error (plus any remaining count) when collapsed and reveal the bounded validator report with received arguments only when expanded. Pi retains its native tool shell and pending/error state.

Dialog footers use configured keybindings where Pi exposes them, format compact labels such as `↑/↓ navigate • Enter select • Esc cancel`, and show `1-N select/toggle`. Hints wrap between actions so each key stays beside its meaning. Question-switching hints appear only in multi-question flows, and unbound actions are omitted.

## Limits

- Questions, labels, descriptions, and previews have input-length limits so the dialog stays usable.
- Notes and custom answers are capped at 4,000 characters.
- Model-facing output is capped at 12,000 characters by shortening long answers and notes evenly; every decision stays in the result.
- Only available in TUI mode. RPC, JSON, and print calls return a structured `no_ui` error.

## Implementation notes

- Uses Pi's native `ctx.ui.custom()` lifecycle; no state is shared with another extension.
- The render cache is keyed by terminal width **and height**, because the option area and preview heights depend on available rows and Pi resize only requests a render. Preview markdown rendering is additionally memoized per text and width so editor keystrokes and option scrolling don't re-parse previews. `option-window.ts` picks the choices around the focused one; `detail-pane.ts` independently pages the reading area with one overlapping line for continuity.
- `validateQuestions` defensively trims every visible text field and rejects whitespace-only content, then enforces case-insensitive uniqueness, reserved-label rejection, and the preview/multi-select conflict. The JSON schema separately carries non-empty, length, and count constraints before execution.
- `prepareArguments` normalizes the three unambiguous argument shapes models actually emit — a lone question written flat at the root wraps into `questions[0]`, a root-level `question` string fills a `questions[0]` object that lost its own `question` field, and a stringified `questions` array parses back into an array. The schema itself keeps a single object shape because strict constrained sampling (which the tool opts into) does not support object unions.
- Dialog navigation follows Pi's injected select/input keybindings where applicable; compact footer labels show the first configured binding in a human-readable form. Custom actions such as Space-to-toggle remain explicit in the footer.
