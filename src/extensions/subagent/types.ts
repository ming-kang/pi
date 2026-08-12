import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SubagentAgentName } from "./constants.ts";

// Static built-in subagent profile; the only agents a task can select.
export interface AgentProfile {
	name: SubagentAgentName;
	description: string;
	tools: string[];
	systemPrompt: string;
	/**
	 * Skip loading AGENTS.md/CLAUDE.md into the worker's system prompt.
	 * Read-only exploration doesn't need commit/PR/style rules; the parent
	 * has full context to interpret results.
	 */
	omitContextFiles?: boolean;
}

export interface SubagentProfileOverride {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface SubagentConfigFile {
	version: 1;
	// Absence means "inherit the parent session"; only the two built-in
	// profiles exist, so unknown keys are rejected by settings.ts.
	profiles: Partial<Record<SubagentAgentName, SubagentProfileOverride>>;
}

export interface ResolvedSubagentTask {
	agent: AgentProfile;
	description: string;
	prompt: string;
	cwd: string;
	model: Model<Api>;
	thinking: ThinkingLevel;
}

export type SubagentRunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
/** Aggregate batch status; active runs beat every terminal verdict. */
export type SubagentBatchStatus = "running" | "completed" | "partial" | "failed" | "aborted";
export type ToolActivityStatus = "running" | "succeeded" | "failed";

export interface ToolActivity {
	id: string;
	toolName: string;
	summary: string;
	status: ToolActivityStatus;
	startedAt: number;
	endedAt?: number;
	resultSummary?: string;
}

export interface SubagentUsage {
	turns: number;
	toolUses: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	/** Context watermark: total tokens of the latest request, not a running sum. */
	contextTokens?: number;
}

export interface SubagentRetryDetails {
	attempt: number;
	maxAttempts: number;
	deadline: number;
	error: string;
}

export interface SubagentRunDetails {
	id: string;
	agent: string;
	description: string;
	cwd: string;
	model: string;
	thinking: ThinkingLevel;
	status: SubagentRunStatus;
	startedAt?: number;
	endedAt?: number;
	currentActivity?: string;
	retry?: SubagentRetryDetails;
	activities: ToolActivity[];
	/** Final assistant report; empty until the worker settles. */
	report: string;
	error?: string;
	usage: SubagentUsage;
}

export interface SubagentDetails {
	status: SubagentBatchStatus;
	runs: SubagentRunDetails[];
	startedAt: number;
	endedAt?: number;
	usage: SubagentUsage;
}

export interface SubagentExecutionResult {
	content: string;
	details: SubagentDetails;
	usage?: Usage;
}
