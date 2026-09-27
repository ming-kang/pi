import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_PROFILES, subagentToolDescription } from "../src/extensions/subagent/agents.ts";
import { MAX_CONCURRENCY, MAX_TASKS, SUBAGENT_AGENT_NAMES } from "../src/extensions/subagent/constants.ts";
import { resolveSubagentTask, resolveTaskCwd } from "../src/extensions/subagent/resolve.ts";
import {
	normalizeSubagentArguments,
	SubagentParamsSchema,
	type SubagentTask,
} from "../src/extensions/subagent/schema.ts";
import { loadSubagentConfig, parseSubagentConfig, updateProfileOverride } from "../src/extensions/subagent/settings.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const configUpdateFixture = fileURLToPath(new URL("./fixtures/subagent-config-update.ts", import.meta.url));

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
		vi.restoreAllMocks();
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("defines exactly the two static built-in profiles with no discovery", () => {
		// No user/project agent discovery exists: the tool description is a
		// constant and the profile list is exactly the two built-ins.
		expect(SUBAGENT_AGENT_NAMES).toEqual(["explorer", "general"]);
		expect(AGENT_PROFILES.map((profile) => profile.name)).toEqual(["explorer", "general"]);
		const [explorer, general] = AGENT_PROFILES;
		expect(explorer?.name).toBe("explorer");
		expect(explorer).not.toHaveProperty("description");
		// Explorer carries bash for git history and similar inspection, but the
		// prompt must pin it read-only, including the bash-native write paths
		// (redirects, heredocs) that the tool list cannot block.
		expect(explorer?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(explorer?.systemPrompt).toContain("read-only inspection only");
		expect(explorer?.systemPrompt).toContain("no redirect (>, >>) or heredoc writes");
		expect(general?.name).toBe("general");
		expect(general).not.toHaveProperty("description");
		expect(general?.tools).toEqual(["read", "bash", "edit", "write"]);
		expect(general?.systemPrompt).toContain("never create documentation files unless the task explicitly asks");
	});

	it("keeps profile copy in the description and concurrency on the tasks parameter", () => {
		const description = subagentToolDescription();
		expect(description).toContain(`Provide 1-${MAX_TASKS} independent tasks`);
		// Concurrency and ordering are stated once, on the parameter that owns them.
		// TypeBox keeps `description` as a runtime JSON Schema annotation only.
		const tasksParam = SubagentParamsSchema.properties.tasks as unknown as { description?: string };
		expect(description).not.toContain("active at once");
		expect(tasksParam.description).toContain(`at most ${MAX_CONCURRENCY} active at once`);
		expect(tasksParam.description).toContain("results preserve input order");
		expect(description).toContain("Agent profiles:");
		expect(description).toContain("- explorer (default):");
		expect(description).toContain("- general:");
		// When-to-delegate routing is promptGuidelines' job; the description keeps
		// only the briefing-quality rule.
		expect(description).not.toContain("Do not delegate a trivial task");
		expect(description).toContain("Never delegate with vague instructions");
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

	it("preserves invalid config bytes, warns, and backs them up on the first real save", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-invalid-"));
		temporaryDirectories.push(root);
		const filePath = join(root, "subagent.json");
		const invalid = JSON.stringify({ version: 1, profiles: { reviewer: {} } });
		writeFileSync(filePath, invalid);
		const warnings: string[] = [];

		await expect(loadSubagentConfig(root, (message) => warnings.push(message))).resolves.toEqual({
			version: 1,
			profiles: {},
		});
		expect(readFileSync(filePath, "utf8")).toBe(invalid);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("left unchanged");
		expect(warnings[0]).toContain(filePath);

		await updateProfileOverride("general", { thinking: "high" }, root);
		expect(parseSubagentConfig(readFileSync(filePath, "utf8")).profiles).toEqual({
			general: { thinking: "high" },
		});
		const backups = readdirSync(root).filter(
			(name) => name.startsWith("subagent.json.invalid-") && name.endsWith(".bak"),
		);
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(root, backups[0]!), "utf8")).toBe(invalid);
	});

	it("persists profile model and thinking overrides atomically", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-settings-"));
		temporaryDirectories.push(root);
		await updateProfileOverride("explorer", { model: "test/sonnet", thinking: "high" }, root);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config).toEqual({ version: 1, profiles: { explorer: { model: "test/sonnet", thinking: "high" } } });
	});

	it("does not create a config file when an override is already inherited", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-noop-settings-"));
		temporaryDirectories.push(root);
		await expect(updateProfileOverride("explorer", { model: undefined }, root)).resolves.toEqual({
			version: 1,
			profiles: {},
		});
		expect(existsSync(join(root, "subagent.json"))).toBe(false);
	});

	it("does not rewrite a valid file for a no-op patch", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-noop-mtime-"));
		temporaryDirectories.push(root);
		const filePath = join(root, "subagent.json");
		await updateProfileOverride("explorer", { thinking: "high" }, root);
		const before = statSync(filePath).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));

		await updateProfileOverride("explorer", { thinking: "high" }, root);
		expect(statSync(filePath).mtimeMs).toBe(before);
	});

	it("times out without modifying the file when another process owns the lock", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-lock-timeout-"));
		temporaryDirectories.push(root);
		const filePath = join(root, "subagent.json");
		writeFileSync(filePath, `${JSON.stringify({ version: 1, profiles: {} })}\n`);
		const before = readFileSync(filePath, "utf8");
		const release = await lockfile.lock(filePath, { realpath: false, stale: 10_000 });
		try {
			await expect(updateProfileOverride("general", { thinking: "high" }, root)).rejects.toThrow(
				/Timed out waiting to update subagent\.json/,
			);
			expect(readFileSync(filePath, "utf8")).toBe(before);
		} finally {
			await release();
		}
	});

	it("cancels saving when an invalid-file backup path cannot be allocated", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-backup-failure-"));
		temporaryDirectories.push(root);
		const filePath = join(root, "subagent.json");
		const invalid = "not json";
		writeFileSync(filePath, invalid);
		vi.spyOn(Date, "now").mockReturnValue(1234);
		for (let attempt = 0; attempt < 100; attempt++) {
			const suffix = attempt === 0 ? "" : `-${attempt}`;
			writeFileSync(`${filePath}.invalid-1234-${process.pid}${suffix}.bak`, "occupied");
		}

		await expect(updateProfileOverride("general", { thinking: "high" }, root)).rejects.toThrow(
			/Could not allocate a backup path/,
		);
		expect(readFileSync(filePath, "utf8")).toBe(invalid);
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

	it("merges same-profile fields written by separate Node processes", async () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-cross-process-"));
		temporaryDirectories.push(root);
		await Promise.all([
			execFileAsync(process.execPath, [tsxCli, configUpdateFixture, root, "explorer", "model", "test/sonnet"]),
			execFileAsync(process.execPath, [tsxCli, configUpdateFixture, root, "explorer", "thinking", "high"]),
		]);

		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config.profiles.explorer).toEqual({ model: "test/sonnet", thinking: "high" });
		expect(readdirSync(root).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
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

	it("marks directories outside the parent as untrusted instead of rejecting them", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-cwd-"));
		temporaryDirectories.push(root);
		const outside = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-outside-"));
		temporaryDirectories.push(outside);

		// Relative traversal, an absolute sibling, and the parent itself all
		// resolve, flagged as outside the parent.
		const relativeEscape = resolveTaskCwd(root, relative(root, outside));
		expect(relativeEscape).toEqual({ cwd: realpathSync(outside), insideParent: false });
		expect(resolveTaskCwd(root, outside)).toEqual({ cwd: realpathSync(outside), insideParent: false });
		expect(resolveTaskCwd(root, join(root, ".."))).toEqual({
			cwd: realpathSync(join(root, "..")),
			insideParent: false,
		});

		// Inside the parent: default, relative child, absolute child, and the
		// parent echoed back as an absolute path all stay trusted.
		expect(resolveTaskCwd(root, undefined)).toEqual({ cwd: realpathSync(root), insideParent: true });
		expect(resolveTaskCwd(root, root)).toEqual({ cwd: realpathSync(root), insideParent: true });
		const sub = join(root, "sub");
		mkdirSync(sub, { recursive: true });
		expect(resolveTaskCwd(root, "sub")).toEqual({ cwd: realpathSync(sub), insideParent: true });
		expect(resolveTaskCwd(root, sub)).toEqual({ cwd: realpathSync(sub), insideParent: true });
	});

	it("names the nearest existing parent when the cwd does not exist", () => {
		const root = mkdtempSync(join(process.env.TEMP ?? "/tmp", "pi-subagent-missing-"));
		temporaryDirectories.push(root);
		expect(() => resolveTaskCwd(root, join("missing", "deeper"))).toThrow(
			new RegExp(`does not exist; nearest existing parent: ${escapeRegExp(realpathSync(root))}$`),
		);
		const file = join(root, "file.txt");
		writeFileSync(file, "not a directory");
		expect(() => resolveTaskCwd(root, "file.txt")).toThrow(/is not a directory/);
	});

	it("accepts a symlinked parent cwd and treats symlink escapes as outside", () => {
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
		expect(resolveTaskCwd(link, undefined)).toEqual({ cwd: realpathSync(real), insideParent: true });
		expect(resolveTaskCwd(link, "sub")).toEqual({ cwd: realpathSync(join(real, "sub")), insideParent: true });
		expect(resolveTaskCwd(link, realpathSync(join(real, "sub")))).toEqual({
			cwd: realpathSync(join(real, "sub")),
			insideParent: true,
		});
		// A symlink inside the tree that points outside runs untrusted.
		expect(resolveTaskCwd(link, "escape")).toEqual({ cwd: realpathSync(outside), insideParent: false });
	});
});

describe("normalizeSubagentArguments", () => {
	it("wraps a single task written at the root into tasks[0]", () => {
		expect(
			normalizeSubagentArguments({
				agent: "general",
				prompt: "Audit the rewind extension.",
				description: "Audit rewind",
				cwd: "src/extensions",
			}),
		).toEqual({
			tasks: [
				{
					agent: "general",
					prompt: "Audit the rewind extension.",
					description: "Audit rewind",
					cwd: "src/extensions",
				},
			],
		});
	});

	it("keeps background at the root when wrapping a single task", () => {
		expect(normalizeSubagentArguments({ prompt: "Audit.", background: true })).toEqual({
			background: true,
			tasks: [{ prompt: "Audit." }],
		});
	});

	it("drops root-level null leftovers from strict-mode sampling", () => {
		expect(
			normalizeSubagentArguments({ agent: null, cwd: null, description: null, tasks: [{ prompt: "Audit." }] }),
		).toEqual({ tasks: [{ prompt: "Audit." }] });
	});

	it("keeps non-null unknown fields for validation to name", () => {
		const args = normalizeSubagentArguments({
			tasks: [{ prompt: "Audit.", prompt_extra: "briefing content" }],
			timeout: 30,
		}) as unknown as Record<string, unknown>;
		expect(args.timeout).toBe(30);
		expect((args.tasks as Array<Record<string, unknown>>)[0]?.prompt_extra).toBe("briefing content");
	});

	it("leaves well-formed and non-object arguments untouched", () => {
		const wellFormed = { tasks: [{ prompt: "Audit." }] };
		expect(normalizeSubagentArguments(wellFormed)).toEqual(wellFormed);
		expect(normalizeSubagentArguments(null)).toBeNull();
		expect(normalizeSubagentArguments("nope")).toBe("nope");
		// A root prompt does not hijack a call that already carries tasks.
		expect(normalizeSubagentArguments({ prompt: "stray", tasks: [{ prompt: "Audit." }] })).toEqual({
			prompt: "stray",
			tasks: [{ prompt: "Audit." }],
		});
	});
});

describe("subagent strict constrained sampling", () => {
	it("keeps the schema inside the strict subset", () => {
		expect(() => makeStrictJsonSchema(SubagentParamsSchema)).not.toThrow();
	});
});
