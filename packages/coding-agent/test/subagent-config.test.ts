import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/extensions/subagent/agents.ts";
import { resolveSubagentTask, resolveTaskCwd } from "../src/extensions/subagent/resolve.ts";
import type { SubagentTask } from "../src/extensions/subagent/schema.ts";
import { parseSubagentConfig, updateProfileOverride } from "../src/extensions/subagent/settings.ts";

function model(provider: string, id: string, reasoning = true): Model<Api> {
	return {
		id,
		name: id,
		api: "test-api",
		provider,
		baseUrl: "https://example.test",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function writeAgent(dir: string, fileName: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, fileName), content, "utf8");
}

const parentModel = model("test", "parent");
const sonnet = model("test", "sonnet");

function parentContext() {
	return {
		model: parentModel,
		thinking: "medium" as ThinkingLevel,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "test" && id === "sonnet"
					? sonnet
					: provider === "test" && id === "parent"
						? parentModel
						: undefined,
			getAvailable: () => [parentModel, sonnet],
			hasConfiguredAuth: () => true,
		},
	};
}

describe("subagent configuration", () => {
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("loads built-ins, user agents, and trusted project overrides", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-config-"));
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const projectAgents = join(root, ".pi", "agents");
		writeAgent(
			join(agentDir, "agents"),
			"reviewer.md",
			"---\nname: reviewer\ndescription: User reviewer\ntools: read, grep\n---\nUser prompt",
		);
		writeAgent(
			projectAgents,
			"reviewer.md",
			"---\nname: reviewer\ndescription: Project reviewer\ntools: read\nmodel: test/sonnet\n---\nProject prompt",
		);

		const trusted = discoverAgents(root, { projectTrusted: true, agentDir });
		const reviewer = trusted.agents.find((agent) => agent.name === "reviewer");
		expect(reviewer).toMatchObject({ description: "Project reviewer", source: "project" });
		// Frontmatter model/thinking are ignored: agent files travel across
		// machines, so pinned models rarely exist in the reader's environment.
		expect(reviewer).not.toHaveProperty("model");
		expect(reviewer).not.toHaveProperty("thinking");
		expect(trusted.agents.some((agent) => agent.name === "general")).toBe(true);
		expect(trusted.projectAgentsTrusted).toBe(true);

		const untrusted = discoverAgents(root, { projectTrusted: false, agentDir });
		expect(untrusted.agents.find((agent) => agent.name === "reviewer")).toMatchObject({
			description: "User reviewer",
			source: "user",
		});
		expect(untrusted.projectAgentsTrusted).toBe(false);
	});

	it("reports invalid agent definitions without hiding valid agents", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-diagnostics-"));
		temporaryDirectories.push(root);
		const agentsDir = join(root, "agents");
		writeAgent(agentsDir, "valid.md", "---\nname: valid\ndescription: Valid\n---\nPrompt");
		writeAgent(agentsDir, "invalid.md", "---\nname: Invalid Name\ndescription: Invalid\ntools: unknown\n---\nPrompt");

		const result = discoverAgents(root, { projectTrusted: false, agentDir: root });
		expect(result.agents.some((agent) => agent.name === "valid")).toBe(true);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.path).toContain("invalid.md");
	});

	it("persists profile model and thinking overrides atomically", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-settings-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("reviewer", { model: "test/sonnet", thinking: "high" }, root);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config).toEqual({ version: 1, profiles: { reviewer: { model: "test/sonnet", thinking: "high" } } });
	});

	it("resolves overrides above parent inheritance and keeps the parent session unchanged", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-resolution-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("reviewer", { model: "test/sonnet", thinking: "high" }, root);
		const task: SubagentTask = { agent: "reviewer", description: "Review", prompt: "Review this" };
		const reviewer = {
			name: "reviewer",
			description: "Reviewer",
			tools: ["read"],
			systemPrompt: "Review",
			source: "user" as const,
			filePath: "reviewer.md",
			backend: "sdk" as const,
		};
		const resolved = await resolveSubagentTask(task, root, [reviewer], parentContext(), root);
		expect(resolved.model).toBe(sonnet);
		expect(resolved.thinking).toBe("high");
		expect(resolved.modelSource).toBe("profile");
		expect(resolved.thinkingSource).toBe("profile");
		expect(parentContext().thinking).toBe("medium");

		await updateProfileOverride("reviewer", { model: undefined, thinking: undefined }, root);
		const inherited = await resolveSubagentTask(task, root, [reviewer], parentContext(), root);
		expect(inherited.model).toBe(parentModel);
		expect(inherited.thinking).toBe("medium");
		expect(inherited.modelSource).toBe("parent");
		expect(inherited.thinkingSource).toBe("parent");
	});

	it("updates override fields independently and drops legacy inherit entries", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-partial-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("reviewer", { thinking: "high" }, root);
		await updateProfileOverride("reviewer", { model: "test/sonnet" }, root);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config.profiles.reviewer).toEqual({ model: "test/sonnet", thinking: "high" });

		const legacy = parseSubagentConfig(
			JSON.stringify({ version: 1, profiles: { reviewer: { model: "inherit", thinking: "inherit" } } }),
		);
		expect(legacy.profiles.reviewer).toEqual({});
	});

	it("rejects absolute and escaping subagent cwd values", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-cwd-"));
		temporaryDirectories.push(root);
		expect(() => resolveTaskCwd(root, "../outside")).toThrow(/escapes/);
		expect(() => resolveTaskCwd(root, root)).toThrow(/relative/);
	});
});
