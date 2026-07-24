import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_LABEL = "Subagent";
export const SUBAGENT_COMMAND_NAME = "agents";
export const SUBAGENT_CONFIG_VERSION = 1;
export const SUBAGENT_CONFIG_FILE = "subagent.json";

export const MAX_TASKS = 8;
export const MAX_CONCURRENCY = 3;

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_AGENT_TOOLS = [...BUILTIN_TOOL_NAMES];
export const EXPLORER_TOOLS = ["read", "grep", "find", "ls"] as const;

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
export const CHAIN_HANDOFF_LIMIT = 16 * 1024;
export const ERROR_TEXT_LIMIT = 8 * 1024;
export const DETAILS_OUTPUT_LIMIT = 120 * 1024;
export const DETAILS_ACTIVITY_LIMIT = 4;
