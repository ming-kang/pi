# BTW side questions

Use `/btw [question]` to ask about the current conversation in a temporary panel above the editor. The main task can keep running while BTW answers.

```text
/btw Why did we choose this approach?
```

An empty `/btw` opens the panel and captures context immediately. Type the first question in the normal editor. Keep asking follow-ups while the panel is open; both Enter and the follow-up submission shortcut send ordinary text to BTW.

Closing the panel discards its questions, answers, and draft. Opening `/btw` again starts a fresh conversation from the main context at that moment. Running `/btw` while a panel is already open also starts fresh. BTW does not pick up later main-task output automatically.

## Controls

| Default key | Action |
| --- | --- |
| Esc | Close the panel and stop its current answer |
| Ctrl+C | Stop the current answer, keeping the panel and partial output; close when idle |
| Up / Down | Scroll the panel when the editor is empty |
| Enter / follow-up shortcut | Submit the next side question |

The follow-up shortcut defaults to Ctrl+Q on Windows and WSL, and Alt+Enter elsewhere. While BTW is answering, another submission stays in the editor as a draft. It is not queued for either conversation.

Up/Down never recall main-conversation history while BTW is open, even when the panel is too short to scroll. They retain cursor movement within a draft; moving past its start cannot enter main history. Dedicated main-history shortcuts are also suspended until the panel closes.

Autocomplete, selectors, and dialogs keep their keyboard focus. Other recognized slash commands, prompt templates, skill commands, and explicit `!` shell commands retain their normal behavior. The panel follows new output until you scroll up; scrolling back to the bottom resumes following.

The panel uses roughly one third of the terminal height. It shows Markdown answers and a two-line thinking preview until answer text arrives. Customize its keys with `app.btw.close`, `app.btw.cancel`, `app.btw.scrollUp`, and `app.btw.scrollDown` in [keybindings.json](../../keybindings.md).

## Context and lifetime

BTW inherits the model, thinking level, effective system prompt, active tool definitions, and stable message history at opening. Partially streamed assistant messages are excluded. If a main tool call is still waiting for a result, BTW sees that its outcome was unknown when the snapshot was taken.

Tools cannot execute in BTW. Answers use the inherited context and side-conversation history. New questions accept text; images already present in the inherited context remain subject to the main session's image policy.

BTW history exists only in memory. It creates no side session file, writes no questions or answers to Session JSONL, and adds nothing to the main conversation, `/tree`, or session exports. Closing, successful tree navigation, session replacement, `/reload`, and exit discard it. Main-context compaction leaves an open BTW conversation and its snapshot intact.

A panel accepts up to 24 questions, each at most 32,000 characters. Context and response sizes are bounded; if a question no longer fits, BTW asks you to reopen after compacting the main conversation. It does not silently trim the inherited context. Repeated tool requests stop after three model steps.

## Cache and usage

BTW keeps the shared request prefix and the main session's provider cache identifier. Its instructions are appended after the inherited history, and tool definitions stay in the request for cache reuse even though execution is disabled. Its native Agent has independent cancellation.

The footer uses the statusline format: `↑` input, `↓` output, `R` cache reads, `W` cache writes, `CH` the latest request's cache hit percentage, and cost when nonzero. Zero-valued counters are omitted. Token totals are local to the panel and are not added to persisted main-session totals. Capture time uses 24-hour `HH:MM:SS`.

Cache hits depend on the provider, model, routing, retention, and timing; a matching prefix does not guarantee a server-side cache hit. The default Moonshot Chat Completions adapter does not emit OpenAI's `prompt_cache_key` field for short retention.

BTW is available in interactive TUI mode.
