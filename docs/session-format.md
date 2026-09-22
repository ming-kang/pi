# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl
```

Pi resolves the working directory to an absolute path, removes one leading `/` or `\`, replaces every `/`, `\`, and `:` with `-`, then wraps the result in `--`. For example, `/path/to/project` is stored under `--path-to-project--`; `C:\Users\me\project` is stored under `--C--Users-me-project--`. By default the session ID is a UUID; callers can supply their own through the SDK or `--session-id`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.pi/agent/sessions/`.

Pi also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, pi uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)

Existing sessions are automatically migrated to the current version (v3) when loaded.

## Public Type Imports

The published packages provide the session and message types used here:

```typescript
import {
  type CompactionEntry,
  type ContextEditEntry,
  type NewSessionOptions,
  type ProjectedSessionEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  type SessionInfo,
  type SessionProjection,
  type SessionTreeNode,
  SessionManager,
} from "@astralyn/pi";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  ImageContent,
  Message,
  ProviderId,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
```

Pi augments `AgentMessage` with its session-specific roles when `@astralyn/pi` is loaded. Extensions can augment it further.

## Message Types

Session message entries contain `AgentMessage` objects. The base message types come from `@earendil-works/pi-ai`; Pi adds the persisted roles described below.

### Content Blocks

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
  namespace?: string;
}
```

### Base Message Types (`@earendil-works/pi-ai`)

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  toolsAdded?: Tool[];
  toolsRemoved?: Array<{ name: string }>;
  timestamp: number;  // Unix ms
}

interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}

interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  usage?: Usage;           // Tool-execution usage, not main context accounting
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;      // Already included in output
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

The exported pi-ai `StopReason` type also includes `"pending"`, but that value is reserved for partial messages in streaming events. Terminal `done` or `error` events replace it with a final completion reason before Pi persists the assistant message, so `"pending"` must never appear in session JSONL. `"deferred"` is a terminal reason for a provider response that will complete later; its `deferred` handle carries the provider data needed to retrieve that response.

### Pi-Specific `AgentMessage` Roles

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: T;                   // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;         // Previous leaf whose abandoned path was summarized
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### `AgentMessage`

`AgentMessage` is the `Message` union from `@earendil-works/pi-ai` plus roles registered through `CustomAgentMessages` in `@earendil-works/pi-agent-core`. Pi registers the four roles above alongside the base `system`, `user`, `assistant`, and `toolResult` roles; extensions may register additional roles.

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // Usually an 8-char hex ID; may fall back to a full UUID
  parentId: string | null;  // Parent entry ID (null for a root entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`. These examples include the required message fields; optional fields from the message shapes above may also be present. System messages carry the prompt and tool loadout: the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; there is no separate prompt state entry.

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant...","tools":"<tools>\n- read: ...\n</tools>","cwd":"/project"},"toolsAdded":[{"name":"read","description":"...","parameters":{}}],"timestamp":1733234400000}}
{"type":"message","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:04:00.000Z","message":{"role":"system","content":"","sections":{"skills":"<skills>...</skills>"},"toolsRemoved":[{"name":"write"}],"timestamp":1733234640000}}
```

Sessions created before system messages existed have no leading system message; the first request declares the current prompt as a later system message, which replays the same way.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f607","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f60718","parentId":"d4e5f607","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### UsageEntry

Records model-attributed usage that is not an assistant message and does not participate in LLM context. `kind` is an arbitrary string identifying the operation; for example, cache warming uses `"cache_warm"`.

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

Usage entries contribute to session token and cost totals. Pi hides them from the conversation tree. Consumers should treat unknown `kind` values as normal usage rather than rejecting them.

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages and a complete system prompt/tool checkpoint. `firstKeptEntryId` is required and identifies the earliest pre-compaction path entry retained alongside the summary.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"You are a coding assistant.","toolsAdded":[],"timestamp":1733235000000}}
```

`firstKeptEntryId` is required. It identifies the first entry retained from before the compaction entry. When rebuilding context, Pi replaces older summarized entries with the compaction summary and keeps the range beginning at this entry. A retain-none compaction stores its own ID in this field, so no preceding entries are retained.

Optional fields:
- `systemMessage`: The replayed prompt sections and tool declarations at the compaction boundary; it becomes the leading system message of the compacted context, and system messages among the kept entries are dropped in its favor. It is absent on older session entries.
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### ContextEditEntry

Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting.

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target message content. String replacements for assistant and tool-result entries are normalized to one text block because those roles require content arrays. If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again. Pi writes these entries itself when auto-retry or overflow recovery abandons an assistant attempt, and extensions can append them from the `turn_end` and `agent_before_settle` boundaries; `/tree` and HTML export list them as bookkeeping entries.

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"0718293a","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6071829","summary":"Branch explored approach A..."}
```

`parentId` is the entry from which the new branch continues. `fromId` is the previous leaf whose abandoned path was summarized.

Optional fields:
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"18293a4b","parentId":"0718293a","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

### Background records

Managed execution uses ordinary version-3 custom entries; it does not add a new session-file version or persist live execution handles. Every managed execution — including a foreground one — appends its own bounded terminal snapshot, so the file carries both the tool result and this snapshot; that duplication is the deliberate price of replay-safe history.

| `customType` | `data` | Purpose |
|---|---|---|
| `background-usage` | `{ version: 1, taskId, usage }` | Independent settlement of provider-reported nested usage |
| `background-task-result` | `{ version: 2, task }` | Bounded terminal `BackgroundTask` snapshot with structured presentation |

`taskId` is the execution/group ID, not a worker display number. `usage` has the `Usage` shape above. Consumers count only the first valid usage record per ID within the entries they aggregate; malformed records, unsupported versions, blank IDs, and non-finite or negative usage/cost values are ignored. A later valid duplicate is not an adjustment. Do not create these host-owned entries yourself or bill again from a result/read/notification.

A `BackgroundTask` has `id`, `kind` (`bash` or `subagent`; PowerShell shares the shell kind), `title`, `toolCallId`, `anchorId`, `mode`, `status`, and numeric millisecond `startedAt`; optional fields include `endedAt`, `command`, `commandTruncated`, `cwd`, `outputPath`, `projection`, `result`, `resultTruncated`, and `error`. Truncation flags record clipping at the producing/retention boundary. Mode (`foreground` or `background`) is independent of status. Persisted terminal statuses are `completed`, `partial`, `failed`, `cancelled`, or `timeout`; live snapshots can also be `queued`, `running`, or `stopping`.

`projection` contains optional bounded status `text`, `shell: { name, output: { text, truncated } }`, and worker summaries. Each worker has `id`, `label`, `profile`, `description`, observed `status`, `report: { text, truncated }`, optional `error`, plus live `prompt`, `activity`, and optional `model`/`usage` display strings. The projection has no worker sessions or execution handles. Source truncation is explicit; the reader never recognizes truncation by matching output text.

The retained tool result contains bounded text (up to 48 KiB) and bounded serializable private details (up to 120 KiB, otherwise omitted); images are replaced with a text omission marker. Completion cards use the public projection independently of those private details. `outputPath`, if present, points to an ephemeral executor-owned file which may already have been removed on eviction or runtime shutdown. Save important output separately.

Terminal history is restored only from the selected branch's valid version-2 result records. Version-1 result records are ignored without migration; their independent usage entries still participate in accounting. This is read-only history: no processes or workers are restarted or reattached, and restoration does not replay usage settlement or completion events. Forks can carry historical entries on their copied path, never live execution handles.

These `custom` entries do not enter model context. Automatic delivery creates a `custom_message` with `customType: "background-completion"`, `display: true`, and a self-contained `BackgroundCompletionSnapshot` in `details`. The session formats `content` from the same snapshot, with a total limit of 48 KiB and 2,000 lines. Each worker gets a share before formatting, so an early report cannot erase later workers. Only `content` is sent to the model.

Completion details use one format, `version: 1`, bounded to 120 KiB of serialized JSON including escaping:

| Part | Fields |
|---|---|
| Common | `version`, `taskId`, `title`, terminal `status`, numeric millisecond `startedAt` and `endedAt`, optional `error` |
| `kind: "bash"` | `output: { text, truncated }`; optional `shell` name, `command: { text, truncated }`, `cwd`, `outputPath` |
| `kind: "subagent"` | `workers[]` with `id`, `label`, `profile`, `description`, observed `status`, `report: { text, truncated }`, optional `error`; optional plain `output` fallback for executors without a worker projection |

Shell output is bounded to 40 KiB, each worker report to 4 KiB, and worker count to eight. Field limits include JSON escaping; source flags survive further clipping. Completion worker snapshots omit live prompt/activity/model/usage fields. Missing shell metadata is left unspecified, and worker status is never inferred from the group verdict. The renderer sanitizes terminal control sequences and applies separate display row limits.

A shell completion's `details` can look like this:

```json
{
  "version": 1,
  "taskId": "bash-12345678-abcd-4321-abcd-123456789012",
  "kind": "bash",
  "title": "Build",
  "status": "completed",
  "startedAt": 1733234400000,
  "endedAt": 1733234405000,
  "shell": "bash",
  "command": { "text": "npm run build", "truncated": false },
  "cwd": "/project",
  "outputPath": "/tmp/pi-bash-example.log",
  "output": { "text": "Build finished", "truncated": false }
}
```

The message carries everything needed for replay after `/reload`, branch navigation, history eviction or restart; rendering does not open the saved log or query a live task. Unsupported or malformed completion details use bounded plain message text. There is no legacy text parser, dual-format reconstruction or migration.

A completion is acknowledged only after its message is persisted. A terminal `bg wait` result instead includes `details.backgroundTaskId`; only persisting that tool result acknowledges delivery, so aborting during an output read cannot consume a notification. Direct `BackgroundContext.wait()` is observational. Snapshots and repeated reads do not create more usage. Historical extension-owned `background-task` notifications and old `bg create` tool results remain transcript history, not new runnable tasks.

Session-wide statistics aggregate the ledger across all entries; the bundled Statusline uses the active branch. Accrued retries, failures, cancellations and worker compaction count when usage is reported. No usage is invented for a provider that does not expose it, and worker billing does not occupy the parent's context window. See [SDK session statistics](sdk.md#session-statistics).

**Late settlement quarantine:** an executor that ignores cancellation and settles after its runtime or launch branch is retired cannot append to the replacement session or move its active leaf. The originating session retains the latest 32 bounded quarantine records in memory. For persisted sessions it also appends audit JSONL to `<session-file>.background-late.jsonl`, with `{ version: 1, sessionId, generation, task, usage? }`. A sidecar write failure is reported and leaves only the bounded in-memory record. This sidecar is separate from the session tree and active totals; it is not automatically reconciled, replayed or used to resume execution. Preserve it if you need to audit late provider costs, and manage its disk retention separately from the session file.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"293a4b5c","parentId":"18293a4b","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"3a4b5c6d","parentId":"293a4b5c","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"4b5c6d7e","parentId":"3a4b5c6d","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries normally form one tree, but navigation APIs can create multiple roots:
- A root entry has `parentId: null`; the first entry is initially the root
- Each non-root entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree
- Calling `resetLeaf()` or `branchWithSummary(null, ...)` allows a later entry to become another root

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildContextEntries()` follows the active path from root to the current leaf. If the path has no compaction entry, it returns that path unchanged. Otherwise it uses only the latest `CompactionEntry` and returns entries in this order:

1. The latest compaction entry itself.
2. Non-system path entries starting at that compaction's required `firstKeptEntryId` and ending immediately before the compaction entry.
3. Every path entry after the compaction entry.

Earlier summarized entries are omitted. Non-message entries in the selected ranges remain in the returned list for rendering and state handling. If a malformed session's `firstKeptEntryId` is not found before the compaction entry, step 2 contributes no entries.

`buildSessionProjection()` applies the latest `context_edit` for each selected target and returns the model-visible messages together with their source entries (`ProjectedSessionEntry`). Omitted targets produce no message; replacements retain the source entry's role and metadata while changing only content. The raw selected entries are not modified. This projection is what `AgentSession` sends to the provider; `agent.state.messages` is only a refreshed copy of it.

`buildSessionContext()` builds on that projection and returns a `SessionContext`, not provider-ready `Message[]` directly:

1. It determines `thinkingLevel` and `model` from the entire active path, including entries omitted by compaction. A `model_change` sets the model, and an assistant message later on the path sets it from that message's `provider` and `model`.
2. It projects the selected entries to `AgentMessage[]` in the order above:
   - `message` → the stored `AgentMessage`; parsed user, assistant, or tool-result messages with null or missing `content` are copied with `content: []`.
   - `compaction` → its complete system checkpoint followed by a `CompactionSummaryMessage`. Pre-compaction system messages are folded into that checkpoint rather than replayed from the retained range.
   - `branch_summary` → `BranchSummaryMessage`.
   - `custom_message` → `CustomMessage`.
   - `context_edit` → no message of its own; it changes the target's contribution.
   - `usage`, `custom`, model/thinking changes, labels, and session-info entries → no message.

Use `convertToLlm()` from `@astralyn/pi` when provider-ready `Message[]` are required. It passes base user, assistant, and tool-result messages through; it converts Pi-specific context roles to user messages and omits `bashExecution` messages marked `excludeFromContext`.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "usage":
      console.log(`[${entry.id}] Usage (${entry.kind}): ${entry.usage.totalTokens} tokens`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "context_edit":
      console.log(`[${entry.id}] Context ${entry.replacement === null ? "omit" : "replace"}: ${entry.targetId}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Import `SessionManager` and its session types from `@astralyn/pi` as shown above. `NewSessionOptions` is `{ id?: string; parentSession?: string }`; `id`, when supplied, must be a valid session ID.

### Static Creation Methods

- `SessionManager.create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager` — create a persisted session.
- `SessionManager.open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager` — open a session file. `cwdOverride` takes precedence over the header's `cwd`.
- `SessionManager.continueRecent(cwd: string, sessionDir?: string): SessionManager` — open the most recent session or create one.
- `SessionManager.inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager` — create a non-persisted session, optionally initialized from entries.
- `SessionManager.forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager` — fork into another working directory.

### Static Listing Methods

The optional progress callback has type `SessionListProgress`: `(loaded: number, total: number, partialSessions?: readonly SessionInfo[]) => void`. Periodic updates carry the sessions loaded so far, sorted by activity. The optional `AbortSignal` cancels outstanding transcript reads.

- `SessionManager.list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>` — list sessions for a directory.
- `SessionManager.listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>` — list all default session directories.
- `SessionManager.listAll(sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>` — list one supplied session directory. This is an overload of the previous form.

### Instance Methods — Session Management

- `newSession(options?: NewSessionOptions): string | undefined` — start a new session; returns its file path only when persisting.
- `setSessionFile(sessionFile: string): void` — switch to a different session file.
- `createBranchedSession(leafId: string): string | undefined` — extract one branch to a new session file; returns no path for an in-memory session.

### Instance Methods — Appending

All of these return the appended entry ID:

- `appendMessage(message: Message | CustomMessage | BashExecutionMessage): string`
- `appendThinkingLevelChange(thinkingLevel: string): string`
- `appendModelChange(provider: string, modelId: string): string`
- `appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string | null, tokensBefore: number, details?: T, fromHook?: boolean, usage?: Usage): string` — `null` creates a retain-none compaction that records its own ID as the kept boundary.
- `appendCustomEntry(customType: string, data?: unknown): string`
- `appendSessionInfo(name: string): string`
- `appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string`
- `appendLabelChange(targetId: string, label: string | undefined): string`
- `appendContextEdit(targetId: string, replacement: { content: ContextEditableContent } | null): string` — the target must be a user, assistant, tool-result, or custom-message entry on the active branch.

### Instance Methods — Tree Navigation

- `getLeafId(): string | null` — get the current position.
- `getLeafEntry(): SessionEntry | undefined` and `getEntry(id: string): SessionEntry | undefined`
- `getBranch(fromId?: string): SessionEntry[]` — walk from an entry (or the leaf) to the root.
- `getTree(): SessionTreeNode[]` — get the complete tree; `getChildren(parentId: string): SessionEntry[]` gets direct children.
- `getLabel(id: string): string | undefined`
- `branch(branchFromId: string): void` — move the leaf to an existing entry.
- `resetLeaf(): void` — reset the leaf to the root position before any entries.
- `branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean, usage?: Usage): string` — branch with a context summary. Pass `null` for `branchFromId` to create the branch from the root.

### Instance Methods — Context and Info

- `buildContextEntries(): SessionEntry[]` — get the compaction-aware active branch.
- `buildSessionProjection(): SessionProjection` — get the context-edited model-visible messages with their source entries, plus thinking level and model.
- `buildSessionContext(): SessionContext` — get `AgentMessage[]`, thinking level, and model from that projection; use `convertToLlm()` for provider messages.
- `getEntries(): SessionEntry[]` and `getHeader(): SessionHeader | null`
- `getSessionName(): string | undefined`
- `getCwd(): string`, `getSessionDir(): string`, `getSessionId(): string`, and `getSessionFile(): string | undefined`
- `usesDefaultSessionDir(): boolean` and `isPersisted(): boolean`
