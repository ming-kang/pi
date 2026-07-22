# question — structured user questions

Adds a `question` tool for asking one to four multiple-choice questions when the agent needs a user decision. A Pi-native take on AskUserQuestion: a lightweight custom dialog with concise transcript summaries and a bounded model-facing result.

## Behavior

- Each option requires a concise description of its consequence or trade-off. Questions, labels, descriptions, and previews have input-length limits so the dialog stays usable.
- A single single-select question submits as soon as the user selects an option.
- A multi-question flow advances after each single-select answer; multi-select uses `Space` to toggle choices and Enter to continue. Once every question is answered, a **Review answers** view requires explicit submission.
- `←` / `→` switch between adjacent questions without wrapping. The tab bar marks answered questions and the Review state.
- `Chat about this` is available after the choices. It returns a `needs_clarification` outcome so the model explains or reformulates instead of treating the user as having declined.
- `Type something.` is appended automatically for custom answers. Authored options may not use reserved labels (`Other`, `Type something.`, `Chat about this`, `Next`).
- `Tab` opens a note editor for the focused option; in multi-select, the option must be selected first. On the custom-answer row, it opens custom-answer input.
- Multi-select custom answers stay on the `Type something.` row, are selected when saved, and can be toggled with `Space` without losing text.
- `preview` shows focused single-select content beside the choices on wide terminals and beneath them on narrow terminals. Preview height is capped and reports hidden lines.
- The dialog is available only in TUI mode. RPC, JSON, and print calls return a structured `no_ui` error rather than attempting a custom component.

## Result contract

`details` preserves structured state for rendering and session history:

```ts
{
  answers,
  outcome: "answered" | "cancelled" | "needs_clarification" | "error",
  cancelled,
  error?,
}
```

Only `content` reaches the model. Successful results are numbered, clearly identify single/custom/multi answers, retain notes, and state when a preview was selected without echoing its full source. Model-facing output is capped at 12,000 characters; if it is truncated, the result instructs the model to ask a focused follow-up question. Notes and custom answers are capped at 4,000 characters in the dialog.

The transcript uses a private `renderCall` / `renderResult` only to replace raw question JSON and model-oriented result text with concise user summaries. Pi retains its native tool shell, pending/error state, and collapsed/expanded behavior.

## Design notes

- Uses Pi's native `ctx.ui.custom()` lifecycle; no state is shared with another extension.
- The render cache is keyed by terminal width **and height**, because preview height depends on available rows and Pi resize only requests a render.
- `validateQuestions` enforces uniqueness, reserved-label rejection, and text budgets beyond what the JSON schema can express.
- Dialog navigation follows Pi's injected select/input keybindings where applicable; custom actions such as Space-to-toggle remain explicit in the footer.

## Files

- `constants.ts` — tool identity and model-facing prompt copy
- `index.ts` — tool registration and execution
- `dialog.ts` — interactive dialog, review, and discussion flow
- `schema.ts` — params and semantic validation
- `state.ts` — per-question dialog state helpers and answer ordering
- `results.ts` — bounded model-result builders
- `render.ts` — compact transcript summaries within Pi's native tool frame
- `limits.ts` — UI and model-output budgets
- `types.ts` — shared interfaces and the `OTHER_OPTION` sentinel
