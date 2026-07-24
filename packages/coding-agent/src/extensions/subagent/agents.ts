import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { BUILTIN_TOOL_NAMES, DEFAULT_AGENT_TOOLS, EXPLORER_TOOLS, THINKING_LEVELS } from "./constants.ts";
import type { AgentDefinition, AgentDiagnostic, AgentDiscoveryResult, AgentSource } from "./types.ts";

const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const BUILTIN_TOOL_SET = new Set<string>(BUILTIN_TOOL_NAMES);
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general",
		description: "General-purpose implementation agent with coding tools",
		tools: [...DEFAULT_AGENT_TOOLS],
		systemPrompt: [
			"Work independently on the delegated task from start to finish.",
			"Inspect relevant repository instructions before changing files.",
			"Keep changes focused, run appropriate verification, and report exact paths, checks, blockers, and remaining risks.",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin:general>",
		backend: "sdk",
	},
	{
		name: "explorer",
		description: "Read-only codebase exploration agent",
		tools: [...EXPLORER_TOOLS],
		thinking: "low",
		systemPrompt: [
			"Explore the delegated question without modifying files.",
			"Use read and search tools to gather exact evidence.",
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

function parseThinking(raw: string | undefined, filePath: string): ThinkingLevel | undefined {
	if (!raw?.trim()) return undefined;
	const value = raw.trim();
	if (!THINKING_LEVEL_SET.has(value)) throw new Error(`Invalid thinking level "${value}" in ${filePath}.`);
	return value as ThinkingLevel;
}

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
		model: frontmatter.model?.trim() || undefined,
		thinking: parseThinking(frontmatter.thinking, filePath),
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

export function formatAgentChoices(discovery: AgentDiscoveryResult): string {
	return discovery.agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; ");
}
