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

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
// Matches the parent session's default toolset; bash covers search needs.
export const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write"] as const;
// Read-only agents get the standalone search tools plus bash for read-only
// inspection (git history, counting); the system prompt constrains bash.
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

export const LIVE_TEXT_LIMIT = 8 * 1024;
export const ACTIVITY_LIMIT = 80;
export const ACTIVITY_TEXT_LIMIT = 24 * 1024;
export const SINGLE_OUTPUT_LIMIT = 32 * 1024;
export const PARALLEL_TASK_OUTPUT_LIMIT = 12 * 1024;
export const PARALLEL_OUTPUT_LIMIT = 48 * 1024;
export const ERROR_TEXT_LIMIT = 8 * 1024;
export const RETRY_ERROR_TEXT_LIMIT = 160;
export const DETAILS_OUTPUT_LIMIT = 120 * 1024;
// Bounded per run inside DETAILS_OUTPUT_LIMIT; each activity costs up to
// ~600 bytes, so 12 keeps an 8-run parallel batch from starving outputs.
export const DETAILS_ACTIVITY_LIMIT = 12;
