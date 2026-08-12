import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_LABEL = "Subagent";
export const SUBAGENT_COMMAND_NAME = "agents";
export const SUBAGENT_CONFIG_VERSION = 1;
export const SUBAGENT_CONFIG_FILE = "subagent.json";

export const MAX_TASKS = 8;
export const MAX_CONCURRENCY = 5;

// Task-level retry for failures that bypass the session's own auto-retry
// (preflight throws such as auth checks). Only runs that produced nothing
// are retried, so a retry never discards partial work.
export const TASK_RETRY_LIMIT = 2;
export const TASK_RETRY_BASE_DELAY_MS = 1_000;

// The only selectable agents: the schema's agent field restricts task items
// to these names, resolve.ts defaults an omitted/null agent to explorer.
export const SUBAGENT_AGENT_NAMES = ["explorer", "general"] as const;
export type SubagentAgentName = (typeof SUBAGENT_AGENT_NAMES)[number];

// Matches the parent session's default toolset; bash covers search needs.
export const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write"] as const;
// The read-only explorer profile gets the standalone search tools plus bash
// for read-only inspection (git history, counting); the system prompt
// constrains bash.
export const EXPLORER_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

export const ACTIVITY_LIMIT = 80;
export const ACTIVITY_TEXT_LIMIT = 24 * 1024;
// Per-task ceiling for the model-facing report; the total cap below wins
// when the batch is large enough that a fair share would exceed it.
export const TASK_OUTPUT_LIMIT = 32 * 1024;
// Total cap for the model-facing report across every task section.
export const TOTAL_OUTPUT_LIMIT = 48 * 1024;
export const ERROR_TEXT_LIMIT = 8 * 1024;
export const RETRY_ERROR_TEXT_LIMIT = 160;
export const DETAILS_OUTPUT_LIMIT = 120 * 1024;
// Bounded per run inside DETAILS_OUTPUT_LIMIT; each activity costs up to
// ~600 bytes, so 12 keeps an 8-run parallel batch from starving outputs.
export const DETAILS_ACTIVITY_LIMIT = 12;
