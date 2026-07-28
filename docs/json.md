# JSON Event Stream Mode

```bash
pi --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating pi into other tools or custom UIs.

## Event Types

Events are defined by `AgentSessionEvent`, exported from [`@astralyn/pi`](https://www.npmjs.com/package/@astralyn/pi):

```typescript
type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
  | { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual" | "threshold" | "overflow" }
  | { type: "summarization_retry_finished" }
  | { type: "bash_execution_update"; id?: string; delta: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Base events retained by `AgentSessionEvent` come from `AgentEvent` in [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core); its `agent_end` member is replaced above:

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base message types come from [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Coding-agent-specific messages are documented in [Session Format](session-format.md):
- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`
- `CompactionSummaryMessage`

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...],"willRetry":false}
```

## Example

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
