import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";

export type AgentSource = "builtin" | "user" | "project";
export type SubagentMode = "single" | "parallel" | "chain";
export type SubagentRunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type ToolActivityStatus = "running" | "succeeded" | "failed";

export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	backend: "sdk";
}

export interface AgentDiagnostic {
	path: string;
	message: string;
	source: Exclude<AgentSource, "builtin">;
}

export interface AgentDiscoveryResult {
	agents: AgentDefinition[];
	diagnostics: AgentDiagnostic[];
	projectAgentsDir?: string;
	projectAgentsTrusted: boolean;
}

export interface SubagentProfileOverride {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface SubagentConfigFile {
	version: 1;
	profiles: Record<string, SubagentProfileOverride>;
}

export interface ResolvedSubagentTask {
	agent: AgentDefinition;
	description: string;
	prompt: string;
	cwd: string;
	model: Model<Api>;
	thinking: ThinkingLevel;
	modelSource: "profile" | "parent";
	thinkingSource: "profile" | "parent";
}

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
}

export interface SubagentRunDetails {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description: string;
	prompt: string;
	cwd: string;
	model: string;
	thinking: ThinkingLevel;
	status: SubagentRunStatus;
	startedAt?: number;
	endedAt?: number;
	currentActivity?: string;
	activities: ToolActivity[];
	liveText: string;
	finalOutput: string;
	error?: string;
	usage: SubagentUsage;
	step?: number;
}

export interface SubagentDetails {
	mode: SubagentMode;
	status: SubagentRunStatus;
	runs: SubagentRunDetails[];
	startedAt: number;
	endedAt?: number;
	usage: SubagentUsage;
	error?: string;
}

export interface SubagentExecutionResult {
	content: string;
	details: SubagentDetails;
	usage?: Usage;
	isError: boolean;
}
