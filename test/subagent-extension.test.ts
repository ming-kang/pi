import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import subagent from "../src/extensions/subagent/index.ts";
import { SubagentParamsSchema, TaskSchema } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";

interface RegisteredCommand {
	name: string;
	description?: string;
}

describe("subagent extension registration", () => {
	it("registers strict foreground tool, refreshes trusted agent guidance, and maps terminal errors", async () => {
		const tools = new Map<string, ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>>();
		const commands: RegisteredCommand[] = [];
		let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
		let toolResultHandler:
			| ((event: { toolName: string; details?: unknown }) => Promise<{ isError: boolean } | undefined>)
			| undefined;
		const pi = {
			registerTool: (tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) =>
				tools.set(tool.name, tool),
			registerCommand: (name: string, options: RegisteredCommand) =>
				commands.push({ name, description: options.description }),
			on: (event: string, handler: unknown) => {
				if (event === "session_start") sessionStartHandler = handler as typeof sessionStartHandler;
				if (event === "tool_result") toolResultHandler = handler as typeof toolResultHandler;
			},
			getThinkingLevel: () => "medium",
		} as unknown as ExtensionAPI;

		subagent(pi);
		expect(tools).toHaveLength(1);
		const initialTool = tools.get("subagent");
		expect(initialTool).toMatchObject({ name: "subagent", label: "Subagent" });
		expect(initialTool?.description).toContain("Available agent profiles:");
		expect(initialTool?.description).toContain("- general (default):");
		expect(initialTool?.promptGuidelines).toEqual([
			"Use subagent when a bounded task benefits from isolated context, parallel investigation, or a sequential specialist handoff; choose a profile and write its briefing using the tool description.",
		]);
		expect(initialTool?.executionMode).toBeUndefined();
		expect(initialTool?.prepareArguments).toBeUndefined();
		// Providers reject tool schemas whose top level is not `type: "object"`,
		// e.g. a union; keep the parameter schema a plain object.
		expect((initialTool?.parameters as unknown as { type?: string }).type).toBe("object");
		const taskAgentSchema = TaskSchema.properties.agent as { description?: string };
		const taskDescriptionSchema = TaskSchema.properties.description as { description?: string };
		const singlePromptSchema = SubagentParamsSchema.properties.prompt as { description?: string };
		expect(taskAgentSchema.description).toContain("list in the tool description");
		expect(taskDescriptionSchema.description).toBe("Concise 3-8 word UI label");
		expect(singlePromptSchema.description).toContain("self-contained briefing");
		expect(commands).toContainEqual({
			name: "agents",
			description: "Configure Subagent profiles, models, and thinking levels",
		});

		const root = mkdtempSync(join(tmpdir(), "pi-subagent-extension-"));
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(root, "agent-config");
		try {
			const projectAgentsDir = join(root, CONFIG_DIR_NAME, "agents");
			mkdirSync(projectAgentsDir, { recursive: true });
			writeFileSync(
				join(projectAgentsDir, "project-only-agent.md"),
				"---\nname: project-only-agent\ndescription: Trusted project specialist\ntools: read\n---\nInspect the project.",
				"utf8",
			);
			await sessionStartHandler?.({ type: "session_start", reason: "startup" }, {
				cwd: root,
				isProjectTrusted: () => true,
			} as ExtensionContext);
			expect(tools).toHaveLength(1);
			expect(tools.get("subagent")?.description).toContain(
				"- project-only-agent: Trusted project specialist (Tools: read)",
			);
			await sessionStartHandler?.({ type: "session_start", reason: "reload" }, {
				cwd: root,
				isProjectTrusted: () => false,
			} as ExtensionContext);
			expect(tools).toHaveLength(1);
			expect(tools.get("subagent")?.description).not.toContain("Trusted project specialist");
		} finally {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}

		const failed = await toolResultHandler?.({ toolName: "subagent", details: { status: "failed" } });
		const completed = await toolResultHandler?.({ toolName: "subagent", details: { status: "completed" } });
		expect(failed).toEqual({ isError: true });
		expect(completed).toBeUndefined();
	});
});
