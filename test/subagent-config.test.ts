import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PROFILES, subagentToolDescription } from "../src/extensions/subagent/agents.ts";
import { MAX_CONCURRENCY, MAX_TASKS, SUBAGENT_AGENT_NAMES } from "../src/extensions/subagent/constants.ts";
import { resolveSubagentTask, resolveTaskCwd } from "../src/extensions/subagent/resolve.ts";
import type { SubagentTask } from "../src/extensions/subagent/schema.ts";
import { loadSubagentConfig, parseSubagentConfig, updateProfileOverride } from "../src/extensions/subagent/settings.ts";

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

	it("defines exactly the two static built-in profiles with no discovery", () => {
		// No user/project agent discovery exists: the tool description is a
		// constant and the profile list is exactly the two built-ins.
		expect(SUBAGENT_AGENT_NAMES).toEqual(["explorer", "general"]);
		expect(AGENT_PROFILES.map((profile) => profile.name)).toEqual(["explorer", "general"]);
		const [explorer, general] = AGENT_PROFILES;
		expect(explorer?.name).toBe("explorer");
		expect(explorer?.description).toContain('"quick" for a targeted lookup');
		// Explorer carries bash for git history and similar inspection, but the
		// prompt must pin it read-only, including the bash-native write paths
		// (redirects, heredocs) that the tool list cannot block.
		expect(explorer?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(explorer?.systemPrompt).toContain("read-only inspection only");
		expect(explorer?.systemPrompt).toContain("no redirect (>, >>) or heredoc writes");
		expect(explorer?.omitContextFiles).toBe(true);
		expect(general?.name).toBe("general");
		expect(general?.tools).toEqual(["read", "bash", "edit", "write"]);
		expect(general?.systemPrompt).toContain("never create documentation files unless the task explicitly asks");
		expect(general?.description).toContain("use explorer for read-only questions");
	});

	it("describes concurrent tasks, queueing, and input-order results", () => {
		const description = subagentToolDescription();
		expect(description).toContain(`Provide 1-${MAX_TASKS} independent tasks`);
		expect(description).toContain(`at most ${MAX_CONCURRENCY} active at once`);
		expect(description).toContain("excess tasks queue, and results preserve input order");
		expect(description).toContain("Agent profiles:");
		expect(description).toContain("- explorer (default):");
		expect(description).toContain("- general:");
		expect(description).toContain("Do not delegate a trivial task");
		// Static guidance: no runtime-discovered agent list appears.
		expect(description).not.toContain("project");
		expect(description).not.toContain("user agent");
	});

	it("rejects unknown profiles, override keys, and top-level fields", () => {
		expect(() => parseSubagentConfig(JSON.stringify({ version: 1, profiles: { reviewer: {} } }))).toThrow(
			/unknown profile "reviewer"/,
		);
		expect(() =>
			parseSubagentConfig(JSON.stringify({ version: 1, profiles: { explorer: { model: "test/sonnet", foo: 1 } } })),
		).toThrow(/unsupported setting\(s\): foo/);
		expect(() =>
			parseSubagentConfig(JSON.stringify({ version: 1, profiles: { explorer: { mode: "parallel" } } })),
		).toThrow(/unsupported setting\(s\): mode/);
		expect(() => parseSubagentConfig(JSON.stringify({ version: 1, profiles: {}, mode: "parallel" }))).toThrow(
			/unsupported field\(s\): mode/,
		);
		expect(() => parseSubagentConfig(JSON.stringify({ version: 2, profiles: {} }))).toThrow(/unsupported version 2/);
		expect(() => parseSubagentConfig("not json")).toThrow(/not valid JSON/);
		expect(() => parseSubagentConfig(JSON.stringify({ version: 1, profiles: { explorer: "high" } }))).toThrow(
			/Profile override for "explorer" must be an object/,
		);
	});

	it("resets stale or invalid config files to an empty inheriting config", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-reset-"));
		temporaryDirectories.push(root);
		for (const stale of [
			JSON.stringify({ version: 1, profiles: { reviewer: {} } }),
			JSON.stringify({ profiles: {} }),
			"not json",
			JSON.stringify({ version: 1, profiles: { explorer: { model: "inherit", thinking: "inherit" } } }),
		]) {
			writeFileSync(join(root, "subagent.json"), stale);
			await expect(loadSubagentConfig(root)).resolves.toEqual({ version: 1, profiles: {} });
			expect(parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"))).toEqual({
				version: 1,
				profiles: {},
			});
		}
		// A later override update writes cleanly onto the reset config.
		await updateProfileOverride("general", { thinking: "high" }, root);
		expect(parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8")).profiles).toEqual({
			general: { thinking: "high" },
		});
	});

	it("persists profile model and thinking overrides atomically", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-settings-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("explorer", { model: "test/sonnet", thinking: "high" }, root);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config).toEqual({ version: 1, profiles: { explorer: { model: "test/sonnet", thinking: "high" } } });
	});

	it("serializes concurrent override updates without losing any profile", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-concurrent-"));
		temporaryDirectories.push(root);
		await Promise.all([
			updateProfileOverride("explorer", { model: "test/sonnet" }, root),
			updateProfileOverride("general", { thinking: "high" }, root),
		]);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config.profiles).toEqual({
			explorer: { model: "test/sonnet" },
			general: { thinking: "high" },
		});
	});

	it("resolves overrides above parent inheritance and keeps the parent session unchanged", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-resolution-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("explorer", { model: "test/sonnet", thinking: "high" }, root);
		const task: SubagentTask = { agent: "explorer", prompt: "Find the widget" };
		const parent = parentContext();
		const resolved = await resolveSubagentTask(task, root, parent, root);
		expect(resolved.agent.name).toBe("explorer");
		expect(resolved.model).toBe(sonnet);
		expect(resolved.thinking).toBe("high");
		expect(parent.thinking).toBe("medium");
		expect(parent.model).toBe(parentModel);

		await updateProfileOverride("explorer", { model: undefined, thinking: undefined }, root);
		const inherited = await resolveSubagentTask(task, root, parentContext(), root);
		expect(inherited.model).toBe(parentModel);
		expect(inherited.thinking).toBe("medium");
	});

	it("defaults an omitted agent to explorer and rejects names outside the enum", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-agent-enum-"));
		temporaryDirectories.push(root);
		const resolved = await resolveSubagentTask({ prompt: "Find it" }, root, parentContext(), root);
		expect(resolved.agent.name).toBe("explorer");
		await expect(
			resolveSubagentTask({ agent: "reviewer" as SubagentTask["agent"], prompt: "X" }, root, parentContext(), root),
		).rejects.toThrow(/Unknown agent "reviewer"\. Available agents: explorer, general/);
	});

	it("updates override fields independently and rejects compatibility aliases", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-partial-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("explorer", { thinking: "high" }, root);
		await updateProfileOverride("explorer", { model: "test/sonnet" }, root);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config.profiles.explorer).toEqual({ model: "test/sonnet", thinking: "high" });

		// A cleared field removes just that override, then the whole entry.
		await updateProfileOverride("explorer", { model: undefined }, root);
		expect(parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8")).profiles.explorer).toEqual({
			thinking: "high",
		});
		await updateProfileOverride("explorer", { thinking: undefined }, root);
		expect(parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8")).profiles.explorer).toBeUndefined();

		expect(() =>
			parseSubagentConfig(
				JSON.stringify({ version: 1, profiles: { explorer: { model: "inherit", thinking: "inherit" } } }),
			),
		).toThrow(/must be a concrete model id/);
		expect(() => parseSubagentConfig(JSON.stringify({ profiles: {} }))).toThrow(/unsupported version undefined/);
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
