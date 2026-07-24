import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import subagent from "../src/extensions/subagent/index.ts";
import type { SubagentParamsSchema } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";

interface RegisteredCommand {
	name: string;
	description?: string;
}

describe("subagent extension registration", () => {
	it("registers strict foreground tool, /agents command, and terminal error mapping", async () => {
		const tools: Array<ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>> = [];
		const commands: RegisteredCommand[] = [];
		let toolResultHandler:
			| ((event: { toolName: string; details?: unknown }) => Promise<{ isError: boolean } | undefined>)
			| undefined;
		const pi = {
			registerTool: (tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) => tools.push(tool),
			registerCommand: (name: string, options: RegisteredCommand) =>
				commands.push({ name, description: options.description }),
			on: (event: string, handler: unknown) => {
				if (event === "tool_result") {
					toolResultHandler = handler as typeof toolResultHandler;
				}
			},
			getThinkingLevel: () => "medium",
		} as unknown as ExtensionAPI;

		subagent(pi);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "subagent", label: "Subagent" });
		expect(tools[0]?.executionMode).toBeUndefined();
		expect(tools[0]?.prepareArguments).toBeUndefined();
		// Providers reject tool schemas whose top level is not `type: "object"`,
		// e.g. a union; keep the parameter schema a plain object.
		expect((tools[0]?.parameters as unknown as { type?: string }).type).toBe("object");
		expect(commands).toContainEqual({
			name: "agents",
			description: "Configure Subagent profiles, models, and thinking levels",
		});

		const failed = await toolResultHandler?.({ toolName: "subagent", details: { status: "failed" } });
		const completed = await toolResultHandler?.({ toolName: "subagent", details: { status: "completed" } });
		expect(failed).toEqual({ isError: true });
		expect(completed).toBeUndefined();
	});
});
