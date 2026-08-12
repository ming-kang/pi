import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { AGENT_PROFILES } from "./agents.ts";
import type { SubagentTask } from "./schema.ts";
import { loadSubagentConfig } from "./settings.ts";
import type { ResolvedSubagentTask, SubagentConfigFile, SubagentProfileOverride } from "./types.ts";

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
	// Models routinely echo the parent working directory back as an absolute
	// path; accept an absolute cwd that stays inside the parent instead of
	// failing the whole task over path style.
	const absolute = value !== undefined && isAbsolute(value);
	const candidate = absolute ? resolve(value) : resolve(parentCwd, value ?? ".");
	// Relative inputs get a lexical traversal check before touching the file
	// system. Absolute inputs may use the real spelling of a symlinked parent,
	// so their containment is decided by the canonical check below.
	if (!absolute && !isWithin(resolve(parentCwd), candidate))
		throw new Error(`Subagent cwd escapes the parent working directory: ${requestedCwd}`);
	if (!existsSync(candidate) || !statSync(candidate).isDirectory())
		throw new Error(`Subagent cwd is not a directory: ${candidate}`);
	const realParent = realpathSync(parentCwd);
	const realCandidate = realpathSync(candidate);
	if (!isWithin(realParent, realCandidate)) {
		if (absolute) throw new Error("cwd must stay inside the parent working directory.");
		throw new Error(`Subagent cwd escapes the parent working directory: ${requestedCwd}`);
	}
	return realCandidate;
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

// Exactly two layers: a /agents override wins, otherwise the subagent
// inherits the parent session. Callers and agent files cannot pick models.
function resolveModel(override: SubagentProfileOverride | undefined, parent: ParentModelContext): Model<Api> {
	if (override?.model) return findAvailableModel(override.model, parent);
	if (!parent.model) throw new Error("The parent session has no active model.");
	return parent.model;
}

function resolveThinking(
	override: SubagentProfileOverride | undefined,
	parent: ParentModelContext,
	model: Model<Api>,
): ThinkingLevel {
	const requested = override?.thinking ?? parent.thinking;
	return clampThinkingLevel(model, requested) as ThinkingLevel;
}

// The schema restricts task.agent to explorer|general; an omitted or null
// agent resolves to the read-only explorer profile.
const DEFAULT_AGENT_NAME = "explorer";

// The schema has no description field; derive a bounded UI label from the
// briefing's first non-empty line so run rows stay readable.
function taskDescription(prompt: string): string {
	const firstLine =
		prompt
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	const characters = [...firstLine];
	return characters.length <= 80 ? firstLine : `${characters.slice(0, 79).join("")}…`;
}

export async function resolveSubagentTask(
	task: SubagentTask,
	parentCwd: string,
	parent: ParentModelContext,
	configAgentDir = getAgentDir(),
	preloadedConfig?: SubagentConfigFile,
): Promise<ResolvedSubagentTask> {
	const agentName = task.agent ?? DEFAULT_AGENT_NAME;
	const agent = AGENT_PROFILES.find((candidate) => candidate.name === agentName);
	if (!agent) {
		const available = AGENT_PROFILES.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(`Unknown agent "${agentName}". Available agents: ${available}.`);
	}
	const config = preloadedConfig ?? (await loadSubagentConfig(configAgentDir));
	const override = config.profiles[agent.name];
	const model = resolveModel(override, parent);
	return {
		agent,
		description: taskDescription(task.prompt),
		prompt: task.prompt,
		cwd: resolveTaskCwd(parentCwd, task.cwd ?? undefined),
		model,
		thinking: resolveThinking(override, parent, model),
	};
}
