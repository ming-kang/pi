import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SubagentAgentName } from "./constants.ts";

// Static built-in subagent profile; the only agents a task can select.
export interface AgentProfile {
	name: SubagentAgentName;
	tools: string[];
	systemPrompt: string;
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

// Flat projection of pi-ai's Usage: the cost breakdown collapses to a
// scalar total (renderers need one number; toNestedUsage rebuilds the nested
// shape for the parent transcript), and turns/toolUses/contextTokens track
// worker progress. The optional pi-ai fields (reasoning, cacheWrite1h) stay
// optional here and are not aggregated.
export type SubagentUsage = Omit<Usage, "cost"> & {
	cost: number;
	turns: number;
	toolUses: number;
	/** Context watermark: total tokens of the latest request, not a running sum. */
	contextTokens?: number;
};

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
	/** Settled submission snapshot; live state belongs to Background. */
	background?: { id: string; submittedAt: number };
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
