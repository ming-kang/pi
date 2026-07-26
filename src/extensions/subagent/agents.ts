import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { utf8Prefix } from "./activity.ts";
import { BUILTIN_TOOL_NAMES, DEFAULT_AGENT_TOOLS, EXPLORER_TOOLS } from "./constants.ts";
import type { AgentDefinition, AgentDiagnostic, AgentDiscoveryResult, AgentSource } from "./types.ts";

const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const BUILTIN_TOOL_SET = new Set<string>(BUILTIN_TOOL_NAMES);
const TOOL_DESCRIPTION_AGENT_LIST_LIMIT = 8_000;
const TOOL_DESCRIPTION_AGENT_SUMMARY_LIMIT = 480;

const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general",
		description: "General-purpose implementation agent with coding tools",
		tools: [...DEFAULT_AGENT_TOOLS],
		systemPrompt: [
			"Work independently on the delegated task from start to finish.",
			"Inspect relevant repository instructions before changing files.",
			"Prefer editing existing files; never create documentation files unless the task explicitly asks for them.",
			"Keep changes focused, run appropriate verification, and report exact paths, checks, blockers, and remaining risks.",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin:general>",
		backend: "sdk",
	},
	{
		name: "explorer",
		description:
			'Fast read-only agent for finding files, searching code, and answering codebase questions. State thoroughness in the prompt: "quick" for a targeted lookup, "medium" for checking likely related locations, or "very thorough" for exhaustive sweeps across locations and naming conventions',
		tools: [...EXPLORER_TOOLS],
		systemPrompt: [
			"You are a fast read-only exploration agent; return findings as quickly as possible.",
			"Explore the delegated question without modifying files.",
			"Use read and search tools to gather exact evidence, batching independent searches and reads instead of running them one at a time.",
			"Match the depth the caller requested: quick targets the direct question, medium checks likely related locations, and very thorough sweeps multiple locations and naming conventions.",
			"Return concise findings with precise paths, symbols, relationships, and unresolved uncertainties.",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin:explorer>",
		backend: "sdk",
	},
];

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function parseTools(raw: string | undefined, filePath: string): string[] {
	if (!raw?.trim()) return [...DEFAULT_AGENT_TOOLS];
	const tools = [
		...new Set(
			raw
				.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean),
		),
	];
	const unsupported = tools.filter((tool) => !BUILTIN_TOOL_SET.has(tool));
	if (unsupported.length > 0) {
		throw new Error(`Unsupported tool(s) ${unsupported.join(", ")} in ${filePath}.`);
	}
	return tools;
}

// Frontmatter model/thinking keys are intentionally ignored: agent files
// travel across machines (project repos), so a pinned model rarely exists
// in the reader's environment. Model and thinking come from /agents
// overrides or default to the parent session.
function parseAgentFile(filePath: string, source: Exclude<AgentSource, "builtin">): AgentDefinition {
	const content = readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	const name = frontmatter.name?.trim() ?? "";
	const description = frontmatter.description?.trim() ?? "";
	if (!name) throw new Error("Missing required frontmatter field: name.");
	if (!AGENT_NAME_PATTERN.test(name)) {
		throw new Error(`Agent name "${name}" must use lowercase letters, digits, hyphens, or underscores.`);
	}
	if (!description) throw new Error("Missing required frontmatter field: description.");
	if (!body.trim()) throw new Error("Agent prompt body must not be empty.");
	const backend = frontmatter.backend?.trim();
	if (backend && backend !== "sdk") throw new Error(`Backend "${backend}" is not implemented; use "sdk".`);
	return {
		name,
		description,
		tools: parseTools(frontmatter.tools, filePath),
		systemPrompt: body.trim(),
		source,
		filePath,
		backend: "sdk",
	};
}

function loadAgentDirectory(
	dir: string,
	source: Exclude<AgentSource, "builtin">,
): { agents: AgentDefinition[]; diagnostics: AgentDiagnostic[] } {
	if (!existsSync(dir)) return { agents: [], diagnostics: [] };
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
	} catch (error) {
		return {
			agents: [],
			diagnostics: [{ path: dir, source, message: error instanceof Error ? error.message : String(error) }],
		};
	}
	const agents: AgentDefinition[] = [];
	const diagnostics: AgentDiagnostic[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = join(dir, entry.name);
		try {
			agents.push(parseAgentFile(filePath, source));
		} catch (error) {
			diagnostics.push({
				path: filePath,
				source,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { agents, diagnostics };
}

export function discoverAgents(
	cwd: string,
	options: { projectTrusted: boolean; agentDir?: string },
): AgentDiscoveryResult {
	const userDir = join(options.agentDir ?? getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const user = loadAgentDirectory(userDir, "user");
	const project =
		options.projectTrusted && projectAgentsDir
			? loadAgentDirectory(projectAgentsDir, "project")
			: { agents: [], diagnostics: [] };
	const agents = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, { ...agent, tools: [...agent.tools] }]));
	for (const agent of user.agents) agents.set(agent.name, agent);
	for (const agent of project.agents) agents.set(agent.name, agent);
	return {
		agents: [...agents.values()],
		diagnostics: [...user.diagnostics, ...project.diagnostics],
		projectAgentsDir,
		projectAgentsTrusted: options.projectTrusted,
	};
}

export function subagentToolDescription(discovery: AgentDiscoveryResult): string {
	const agentLines: string[] = [];
	let agentListLength = 0;
	for (const [index, agent] of discovery.agents.entries()) {
		const normalizedDescription = agent.description.replace(/\s+/gu, " ").trim();
		const description =
			Buffer.byteLength(normalizedDescription, "utf8") <= TOOL_DESCRIPTION_AGENT_SUMMARY_LIMIT
				? normalizedDescription
				: `${utf8Prefix(normalizedDescription, TOOL_DESCRIPTION_AGENT_SUMMARY_LIMIT - Buffer.byteLength("…", "utf8"))}…`;
		const defaultLabel = agent.name === "general" ? " (default)" : "";
		const tools = agent.tools.length > 0 ? agent.tools.join(", ") : "none";
		const line = `- ${agent.name}${defaultLabel}: ${description} (Tools: ${tools})`;
		const lineLength = Buffer.byteLength(line, "utf8") + 1;
		if (agentListLength + lineLength > TOOL_DESCRIPTION_AGENT_LIST_LIMIT) {
			let omitted = discovery.agents.length - index;
			let notice = `- ${omitted} additional profile${omitted === 1 ? "" : "s"} omitted from this bounded description; /agents lists every profile.`;
			while (
				agentLines.length > 0 &&
				agentListLength + Buffer.byteLength(notice, "utf8") + 1 > TOOL_DESCRIPTION_AGENT_LIST_LIMIT
			) {
				const removed = agentLines.pop();
				if (!removed) break;
				agentListLength -= Buffer.byteLength(removed, "utf8") + 1;
				omitted++;
				notice = `- ${omitted} additional profile${omitted === 1 ? "" : "s"} omitted from this bounded description; /agents lists every profile.`;
			}
			agentLines.push(notice);
			break;
		}
		agentLines.push(line);
		agentListLength += lineLength;
	}

	return [
		"Delegate bounded work to isolated one-shot subagents. Choose exactly one mode: prompt for one task, tasks for independent parallel work, or chain for sequential work whose later prompts may include {previous}.",
		"",
		"Available agent profiles:",
		...agentLines,
		"",
		"When not to delegate:",
		"- Read a known file directly with read, or search for a known symbol directly with grep.",
		"- Do not delegate a trivial task when the coordination overhead exceeds the work.",
		"",
		"Writing the briefing:",
		"- Brief the worker like a capable colleague entering the project now: include the objective, relevant context, exact paths or symbols already known, constraints, and expected output.",
		"- Never delegate understanding with vague instructions such as 'fix this based on your findings'; state what must be investigated or changed and whether the worker should research, implement, or review.",
		"- Ask for a concise report when only findings are needed. Workers cannot see the parent conversation or ask the end user questions.",
		"",
		"Subagent results are reports for you to interpret and relay. Surface the important findings, changes, verification, and unresolved risks to the user.",
	].join("\n");
}
