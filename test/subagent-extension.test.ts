import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import subagent from "../src/extensions/subagent/index.ts";
import { SubagentParamsSchema, TaskSchema } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";

interface RegisteredCommand {
	name: string;
	description?: string;
	handler?: unknown;
}

// Collect string enum/const values anywhere in a TypeBox schema.
function stringValues(schema: unknown, output = new Set<string>()): string[] {
	if (schema && typeof schema === "object") {
		const record = schema as Record<string, unknown>;
		if (typeof record.const === "string") output.add(record.const);
		if (Array.isArray(record.enum)) {
			for (const value of record.enum) if (typeof value === "string") output.add(value);
		}
		for (const value of Object.values(record)) {
			if (value && typeof value === "object") stringValues(value, output);
		}
	}
	return [...output];
}

describe("subagent extension registration", () => {
	it("registers the static two-profile tool and maps terminal errors", async () => {
		const tools = new Map<string, ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>>();
		const commands: RegisteredCommand[] = [];
		const registeredEvents: string[] = [];
		let toolResultHandler:
			| ((event: { toolName: string; details?: unknown }) => Promise<{ isError: boolean } | undefined>)
			| undefined;
		const pi = {
			registerTool: (tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) =>
				tools.set(tool.name, tool),
			registerCommand: (name: string, options: RegisteredCommand) =>
				commands.push({ name, description: options.description, handler: options.handler }),
			on: (event: string, handler: unknown) => {
				registeredEvents.push(event);
				if (event === "tool_result") toolResultHandler = handler as typeof toolResultHandler;
			},
			getThinkingLevel: () => "medium",
		} as unknown as ExtensionAPI;

		subagent(pi);
		expect(tools).toHaveLength(1);
		const initialTool = tools.get("subagent");
		expect(initialTool).toMatchObject({ name: "subagent", label: "Subagent" });
		// The description is static: exactly the two built-in profiles, bounded
		// concurrency, and input-order results. No discovery-dependent copy.
		expect(initialTool?.description).toContain("Delegate bounded work to isolated one-shot subagents");
		expect(initialTool?.description).toContain("Workers cannot see the parent conversation");
		expect(initialTool?.description).toContain("Provide 1-8 independent tasks");
		expect(initialTool?.description).toContain("at most 5 active at once, excess tasks queue");
		expect(initialTool?.description).toContain("results preserve input order");
		expect(initialTool?.description).toContain("Agent profiles:");
		expect(initialTool?.description).toContain("- explorer (default):");
		expect(initialTool?.description).toContain("- general:");
		expect(initialTool?.promptSnippet).toBe("Delegate bounded work to isolated Explorer or General workers");
		expect(initialTool?.promptGuidelines).toEqual([
			"Use subagent for bounded work that benefits from isolated context or concurrent investigation; default to explorer, and choose general only when the task may modify files or state.",
		]);
		expect(initialTool?.executionMode).toBeUndefined();
		expect(initialTool?.prepareArguments).toBeUndefined();
		// Providers reject tool schemas whose top level is not `type: "object"`,
		// e.g. a union; keep the parameter schema a plain object.
		expect((initialTool?.parameters as unknown as { type?: string }).type).toBe("object");
		expect(commands).toContainEqual({
			name: "agents",
			description: "Configure Subagent profiles, models, and thinking levels",
			handler: expect.any(Function),
		});
		// No user/project agent discovery hooks: the extension only listens for
		// tool results and shutdown, never session_start.
		expect(registeredEvents).not.toContain("session_start");
		expect(registeredEvents).toContain("tool_result");

		const failed = await toolResultHandler?.({
			toolName: "subagent",
			details: { status: "failed", runs: [{ status: "failed" }] },
		});
		// A batch where any run succeeded is a partial result, not an error.
		const partial = await toolResultHandler?.({
			toolName: "subagent",
			details: { status: "failed", runs: [{ status: "failed" }, { status: "completed" }] },
		});
		const completed = await toolResultHandler?.({
			toolName: "subagent",
			details: { status: "completed", runs: [{ status: "completed" }] },
		});
		expect(failed).toEqual({ isError: true });
		expect(partial).toBeUndefined();
		expect(completed).toBeUndefined();
	});

	it("constrains the schema to a required 1-8 tasks array and the explorer|general enum", () => {
		// Structural view: TypeBox types hide JSON-schema knobs like
		// additionalProperties and array bounds behind their TS types.
		const paramsSchema = SubagentParamsSchema as unknown as {
			type: string;
			required: string[];
			additionalProperties: boolean;
			properties: Record<string, { type?: string; minItems?: number; maxItems?: number; description?: string }>;
		};
		const taskSchema = TaskSchema as unknown as {
			required: string[];
			additionalProperties: boolean;
			properties: Record<string, { type?: string; minLength?: number; description?: string }>;
		};
		expect(paramsSchema.type).toBe("object");
		expect(paramsSchema.required).toEqual(["tasks"]);
		expect(Object.keys(paramsSchema.properties)).toEqual(["tasks"]);
		expect(paramsSchema.additionalProperties).toBe(false);
		// No legacy top-level mode or description fields survive.
		expect(paramsSchema.properties).not.toHaveProperty("mode");
		expect(paramsSchema.properties).not.toHaveProperty("description");

		const tasks = paramsSchema.properties.tasks;
		expect(tasks?.type).toBe("array");
		expect(tasks?.minItems).toBe(1);
		expect(tasks?.maxItems).toBe(8);
		expect(tasks?.description).toContain("at most 5 active at once");
		expect(tasks?.description).toContain("results preserve input order");

		expect(taskSchema.required).toEqual(["prompt"]);
		expect(taskSchema.additionalProperties).toBe(false);
		expect(Object.keys(taskSchema.properties).sort()).toEqual(["agent", "cwd", "prompt"]);
		expect(taskSchema.properties).not.toHaveProperty("mode");
		expect(taskSchema.properties).not.toHaveProperty("description");
		expect(taskSchema.properties.prompt?.type).toBe("string");
		expect(taskSchema.properties.prompt?.minLength).toBe(1);
		const agentSchema = taskSchema.properties.agent as { description?: string };
		expect(agentSchema.description).toContain("null or omit for explorer (the default)");
		// The agent enum is exactly the two static profiles.
		expect(stringValues(agentSchema).sort()).toEqual(["explorer", "general"]);
	});
});
