import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, subagentToolDescription } from "../src/extensions/subagent/agents.ts";
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
		const general = trusted.agents.find((agent) => agent.name === "general");
		const explorer = trusted.agents.find((agent) => agent.name === "explorer");
		expect(general?.systemPrompt).toContain("never create documentation files unless the task explicitly asks");
		expect(general?.description).toContain("use explorer for read-only questions");
		expect(explorer?.description).toContain('"quick" for a targeted lookup');
		expect(explorer?.systemPrompt).toContain("batching independent searches and reads");
		// Explorer carries bash for git history and similar inspection, but the
		// prompt must pin it read-only, including the bash-native write paths
		// (redirects, heredocs) that the tool list cannot block.
		expect(explorer?.tools).toContain("bash");
		expect(explorer?.description).toContain("git history");
		expect(explorer?.systemPrompt).toContain("read-only inspection only");
		expect(explorer?.systemPrompt).toContain("no redirect (>, >>) or heredoc writes");
		expect(explorer?.omitContextFiles).toBe(true);
		const trustedToolDescription = subagentToolDescription(trusted);
		expect(trustedToolDescription).toContain("- reviewer: Project reviewer (Tools: read)");
		expect(trustedToolDescription).toContain("When not to delegate:");
		expect(trustedToolDescription).toContain("Never delegate understanding");

		const untrusted = discoverAgents(root, { projectTrusted: false, agentDir });
		expect(untrusted.agents.find((agent) => agent.name === "reviewer")).toMatchObject({
			description: "User reviewer",
			source: "user",
		});
		expect(untrusted.projectAgentsTrusted).toBe(false);
		const untrustedToolDescription = subagentToolDescription(untrusted);
		expect(untrustedToolDescription).toContain("- reviewer: User reviewer (Tools: read, grep)");
		expect(untrustedToolDescription).not.toContain("Project reviewer");
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

	it("bounds agent metadata before placing it in the model-facing tool description", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-description-"));
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		for (let index = 0; index < 50; index++) {
			writeAgent(
				join(agentDir, "agents"),
				`worker-${index}.md`,
				`---\nname: worker-${index}\ndescription: ${"细节 ".repeat(200)}\ntools: read\n---\nPrompt`,
			);
		}

		const description = subagentToolDescription(discoverAgents(root, { projectTrusted: false, agentDir }));
		expect(Buffer.byteLength(description, "utf8")).toBeLessThan(10 * 1024);
		expect(description).toContain("additional profiles omitted from this bounded description");
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

	it("accepts an absolute cwd inside the parent and rejects escapes", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-cwd-"));
		temporaryDirectories.push(root);
		expect(() => resolveTaskCwd(root, "../outside")).toThrow(/escapes/);
		// Models routinely echo the parent cwd back as an absolute path.
		expect(resolveTaskCwd(root, root)).toBe(realpathSync(root));
		const sub = join(root, "sub");
		mkdirSync(sub, { recursive: true });
		expect(resolveTaskCwd(root, sub)).toBe(realpathSync(sub));
		expect(() => resolveTaskCwd(root, join(root, ".."))).toThrow(/stay inside/);
	});

	it("accepts a symlinked parent cwd and still blocks symlink escapes", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-symlink-"));
		temporaryDirectories.push(root);
		const real = join(root, "real");
		mkdirSync(join(real, "sub"), { recursive: true });
		const link = join(root, "link");
		symlinkSync(real, link, "junction");
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(real, "escape"), "junction");

		// Symlinked parent (macOS /tmp, Windows junctions): the default,
		// a relative child, and the child's real absolute spelling all resolve.
		expect(resolveTaskCwd(link, undefined)).toBe(realpathSync(real));
		expect(resolveTaskCwd(link, "sub")).toBe(realpathSync(join(real, "sub")));
		expect(resolveTaskCwd(link, realpathSync(join(real, "sub")))).toBe(realpathSync(join(real, "sub")));
		// A symlink inside the tree that points outside still escapes.
		expect(() => resolveTaskCwd(link, "escape")).toThrow(/escapes/);
	});
});
