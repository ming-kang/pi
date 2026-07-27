# question — structured user questions

Adds a `question` tool for asking one to four multiple-choice questions when the agent needs a user decision. A Pi-native take on AskUserQuestion: a lightweight custom dialog with concise transcript summaries and a bounded model-facing result.

## Behavior

- Each option requires a concise description of its consequence or trade-off. Questions, labels, descriptions, and previews have input-length limits so the dialog stays usable.
- A single single-select question submits as soon as the user selects an option.
- A multi-question flow advances after each single-select answer; multi-select uses `Space` to toggle choices and Enter to continue. Once every question is answered, a **Review answers** view requires explicit submission.
- Options are numbered; pressing `1`–`9` jumps to the matching option — selecting it in single-select, toggling it in multi-select. The custom-answer row's number opens its input.
- `←` / `→` switch between adjacent questions without wrapping. The tab bar marks answered questions and the Review state.
- `Chat about this` is available after the choices. It returns a `needs_clarification` outcome so the model explains or reformulates instead of treating the user as having declined.
- `Type something` is appended automatically for custom answers. Authored options may not use reserved labels (`Other`, `Type something`, the legacy `Type something.`, or `Chat about this`); the comparison is case-insensitive and ignores surrounding whitespace.
- `Tab` opens a note editor for the focused option; in multi-select, the option must be selected first. In single-select it also selects the option, and cancelling the note editor with `Esc` restores the previous selection. On the custom-answer row, it opens custom-answer input.
- Multi-select custom answers stay on the `Type something` row, are selected when saved, and can be toggled with `Space` without losing text. Enter on that row opens the input while no custom answer exists yet.
- `preview` shows focused single-select content beside the choices on wide terminals and beneath them on narrow terminals. Preview height is capped and reports hidden lines. Previews on multi-select questions are rejected with a `preview_multiselect` error.
- The dialog is available only in TUI mode. RPC, JSON, and print calls return a structured `no_ui` error rather than attempting a custom component.
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

Only `content` reaches the model. Successful results are numbered, clearly identify single/custom/multi answers, retain notes, and state when a preview was selected without echoing its full source. Cancelling — via `Esc` or a turn abort — lists any answers already given as partial answers alongside the decline message. Model-facing output is capped at 12,000 characters; if it is truncated, the result instructs the model to ask a focused follow-up question. Notes and custom answers are capped at 4,000 characters in the dialog.

The transcript uses a private `renderCall` / `renderResult` only to replace raw question JSON and model-oriented result text with concise user summaries. The collapsed call keeps a bounded header; expanding lists every question in full and marks multi-select prompts. Cancelled and clarification outcomes report `answered N of M`, and the expanded result preserves partial decisions and notes. Human-readable validation errors are shown instead of machine codes, while older or malformed session details fall back defensively to bounded content. Schema-level argument failures show only the first bounded error (plus any remaining count) when collapsed and reveal the bounded validator report with received arguments only when expanded. Pi retains its native tool shell and pending/error state.

Dialog footers use configured keybindings where Pi exposes them, format compact labels such as `↑/↓ navigate • Enter select • Esc cancel`, and show `1-N select/toggle`. Unbound actions are omitted rather than advertising a key that does not work.

## Limits

- Questions, labels, descriptions, and previews have input-length limits so the dialog stays usable.
- Notes and custom answers are capped at 4,000 characters.
- Model-facing output is capped at 12,000 characters; if truncated, the result instructs the model to ask a focused follow-up question.
- Only available in TUI mode. RPC, JSON, and print calls return a structured `no_ui` error.

## Implementation notes

- Uses Pi's native `ctx.ui.custom()` lifecycle; no state is shared with another extension.
- The render cache is keyed by terminal width **and height**, because preview height depends on available rows and Pi resize only requests a render. Preview markdown rendering is additionally memoized per text and dimensions so editor keystrokes don't re-parse previews.
- `validateQuestions` enforces only what the JSON schema cannot express: case-insensitive uniqueness, reserved-label rejection, and the preview/multi-select conflict. Length and count limits are enforced against the schema before the tool executes.
- Dialog navigation follows Pi's injected select/input keybindings where applicable; compact footer labels show the first configured binding in a human-readable form. Custom actions such as Space-to-toggle remain explicit in the footer.
