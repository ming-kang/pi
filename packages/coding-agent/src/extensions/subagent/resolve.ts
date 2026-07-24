import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { SubagentTask } from "./schema.ts";
import { loadSubagentConfig } from "./settings.ts";
import type { AgentDefinition, ResolvedSubagentTask, SubagentProfileOverride } from "./types.ts";

export interface ParentModelContext {
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
	modelRegistry: Pick<ModelRegistry, "find" | "getAvailable" | "hasConfiguredAuth">;
}

function normalizeCwdInput(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) throw new Error("cwd must not be empty.");
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function isWithin(parent: string, child: string): boolean {
	const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
	const normalizedChild = process.platform === "win32" ? child.toLowerCase() : child;
	const rest = relative(normalizedParent, normalizedChild);
	return rest === "" || (rest !== ".." && !rest.startsWith(`..${requirePathSeparator()}`) && !isAbsolute(rest));
}

function requirePathSeparator(): string {
	return process.platform === "win32" ? "\\" : "/";
}

export function resolveTaskCwd(parentCwd: string, requestedCwd: string | undefined): string {
	const value = normalizeCwdInput(requestedCwd);
	if (value !== undefined && isAbsolute(value))
		throw new Error("cwd must be a relative path inside the parent working directory.");
	const candidate = resolve(parentCwd, value ?? ".");
	const realParent = realpathSync(parentCwd);
	if (!isWithin(realParent, candidate))
		throw new Error(`Subagent cwd escapes the parent working directory: ${requestedCwd}`);
	if (!existsSync(candidate) || !statSync(candidate).isDirectory())
		throw new Error(`Subagent cwd is not a directory: ${candidate}`);
	const realCandidate = realpathSync(candidate);
	if (!isWithin(realParent, realCandidate))
		throw new Error(`Subagent cwd escapes the parent working directory: ${requestedCwd}`);
	return realCandidate;
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function findAvailableModel(spec: string, parent: ParentModelContext): Model<Api> {
	const normalized = spec.trim();
	let model: Model<Api> | undefined;
	if (normalized.includes("/")) {
		const separator = normalized.indexOf("/");
		model = parent.modelRegistry.find(normalized.slice(0, separator), normalized.slice(separator + 1));
	} else {
		const matches = parent.modelRegistry.getAvailable().filter((candidate) => candidate.id === normalized);
		if (matches.length === 1) model = matches[0];
		if (matches.length > 1) throw new Error(`Model id "${normalized}" is ambiguous; use provider/model.`);
	}
	if (!model) throw new Error(`Model "${normalized}" is not available.`);
	if (!parent.modelRegistry.hasConfiguredAuth(model))
		throw new Error(`Model "${normalized}" has no configured authentication.`);
	return model;
}

function resolveModel(
	task: SubagentTask,
	agent: AgentDefinition,
	override: SubagentProfileOverride | undefined,
	parent: ParentModelContext,
): { model: Model<Api>; source: ResolvedSubagentTask["modelSource"] } {
	if (task.model) return { model: findAvailableModel(task.model, parent), source: "call" };
	if (override?.model === "inherit") {
		if (!parent.model) throw new Error("The parent session has no active model to inherit.");
		return { model: parent.model, source: "profile" };
	}
	if (typeof override?.model === "string")
		return { model: findAvailableModel(override.model, parent), source: "profile" };
	if (agent.model) return { model: findAvailableModel(agent.model, parent), source: "agent" };
	if (!parent.model) throw new Error("The parent session has no active model.");
	return { model: parent.model, source: "parent" };
}

function resolveThinking(
	task: SubagentTask,
	agent: AgentDefinition,
	override: SubagentProfileOverride | undefined,
	parent: ParentModelContext,
	model: Model<Api>,
): { thinking: ThinkingLevel; source: ResolvedSubagentTask["thinkingSource"] } {
	let requested: ThinkingLevel;
	let source: ResolvedSubagentTask["thinkingSource"];
	if (task.thinking) {
		requested = task.thinking;
		source = "call";
	} else if (override?.thinking === "inherit") {
		requested = parent.thinking;
		source = "profile";
	} else if (override?.thinking) {
		requested = override.thinking;
		source = "profile";
	} else if (agent.thinking) {
		requested = agent.thinking;
		source = "agent";
	} else {
		requested = parent.thinking;
		source = "parent";
	}
	return { thinking: clampThinkingLevel(model, requested) as ThinkingLevel, source };
}

export async function resolveSubagentTask(
	task: SubagentTask,
	parentCwd: string,
	agents: readonly AgentDefinition[],
	parent: ParentModelContext,
	configAgentDir = getAgentDir(),
): Promise<ResolvedSubagentTask> {
	const agentName = task.agent ?? "general";
	const agent = agents.find((candidate) => candidate.name === agentName);
	if (!agent) {
		const available = agents.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(`Unknown agent "${agentName}". Available agents: ${available}.`);
	}
	const config = await loadSubagentConfig(configAgentDir);
	const override = config.profiles[agent.name];
	const resolvedModel = resolveModel(task, agent, override, parent);
	const resolvedThinking = resolveThinking(task, agent, override, parent, resolvedModel.model);
	return {
		agent,
		description: task.description,
		prompt: task.prompt,
		cwd: resolveTaskCwd(parentCwd, task.cwd),
		model: resolvedModel.model,
		thinking: resolvedThinking.thinking,
		modelSource: resolvedModel.source,
		thinkingSource: resolvedThinking.source,
	};
}

export async function loadProfileOverrides(
	agentDir = getAgentDir(),
): Promise<Awaited<ReturnType<typeof loadSubagentConfig>>> {
	return loadSubagentConfig(agentDir);
}

export function modelLabel(model: Model<Api>): string {
	return formatModel(model);
}
