import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	createToolDefinitionFromAgentTool,
	wrapToolDefinition,
	wrapToolDefinitions,
} from "../src/core/tools/tool-definition-wrapper.ts";

const TaskSchema = Type.Object(
	{
		agent: Type.Optional(Type.String()),
		prompt: Type.String(),
		description: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const BatchSchema = Type.Object(
	{
		background: Type.Optional(Type.Boolean()),
		tasks: Type.Array(TaskSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

function definition(overrides?: Partial<ToolDefinition<typeof BatchSchema>>) {
	return {
		name: "batch",
		label: "Batch",
		description: "Process a batch",
		parameters: BatchSchema,
		execute: vi.fn(),
		...overrides,
	} as ToolDefinition<typeof BatchSchema>;
}

describe("wrapToolDefinition validation hints", () => {
	it.each([{ kind: "file", path: "a.txt" }, { kind: "file" }, { kind: "http", url: "https://example.com" }])(
		"does not mix requirements of alternative object shapes: %j",
		(mode) => {
			const wrapped = wrapToolDefinition({
				name: "transport",
				label: "Transport",
				description: "Transport",
				parameters: Type.Object({
					count: Type.Integer(),
					mode: Type.Union([
						Type.Object({ kind: Type.Literal("file"), path: Type.String() }, { additionalProperties: false }),
						Type.Object({ kind: Type.Literal("http"), url: Type.String() }, { additionalProperties: false }),
					]),
				}),
				execute: vi.fn(),
			});
			try {
				wrapped.prepareArguments?.({ mode });
				expect.unreachable("validation should fail for missing count");
			} catch (error) {
				const message = (error as Error).message;
				expect(message).toContain("Hint: count is required");
				expect(message).not.toContain("Hint: mode.");
			}
		},
	);

	it("returns valid arguments untouched, by reference when nothing was prepared", () => {
		const raw = { tasks: [{ prompt: "Audit." }] };
		expect(wrapToolDefinition(definition()).prepareArguments?.(raw)).toBe(raw);
	});

	it("runs the definition's own prepareArguments before validating", () => {
		const prepare = vi.fn((raw: unknown) => ({ tasks: [{ prompt: (raw as { prompt: string }).prompt }] }));
		const wrapped = wrapToolDefinition(definition({ prepareArguments: prepare }));
		expect(wrapped.prepareArguments?.({ prompt: "Audit." })).toEqual({ tasks: [{ prompt: "Audit." }] });
		expect(prepare).toHaveBeenCalledOnce();
	});

	it("names the legal fields next to an unknown nested field", () => {
		const wrapped = wrapToolDefinition(definition());
		try {
			wrapped.prepareArguments?.({ tasks: [{ prompt: "Audit.", prompt_extra: "briefing content" }] });
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain('Validation failed for tool "batch":');
			expect(message).toContain(
				"Hint: tasks[0].prompt_extra is not a field; fields at tasks[0]: agent, prompt, description, cwd",
			);
		}
	});

	it("names the legal fields next to a missing required field", () => {
		const wrapped = wrapToolDefinition(definition());
		try {
			wrapped.prepareArguments?.({ background: true });
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Hint: tasks is required; fields at root: background, tasks");
		}
	});

	it("ignores null unknown fields (strict-mode leftovers carry no information)", () => {
		const wrapped = wrapToolDefinition(definition());
		try {
			wrapped.prepareArguments?.({ tasks: [{ prompt: "Audit." }], agent: null, timeout: 30 });
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Hint: timeout is not a field; fields at root: background, tasks");
			expect(message).not.toContain("agent is not a field");
		}
	});

	it("collects hints inside nullable fields, whose schema nests under anyOf", () => {
		const NullableSchema = Type.Object(
			{
				name: Type.String(),
				meta: Type.Optional(
					Type.Union([
						Type.Object(
							{ label: Type.String(), note: Type.Optional(Type.String()) },
							{
								additionalProperties: false,
							},
						),
						Type.Null(),
					]),
				),
			},
			{ additionalProperties: false },
		);
		const wrapped = wrapToolDefinition({
			name: "job",
			label: "Job",
			description: "d",
			parameters: NullableSchema,
			execute: vi.fn(),
		} as ToolDefinition<typeof NullableSchema>);
		try {
			wrapped.prepareArguments?.({ name: "x", meta: { label: "y", extra: "z" } });
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Hint: meta.extra is not a field; fields at meta: label, note");
		}
	});

	it("bounds the echoed arguments to about 2KB", () => {
		const wrapped = wrapToolDefinition(definition());
		const huge = { tasks: [{ prompt: "x".repeat(50_000), prompt_extra: "y" }] };
		try {
			wrapped.prepareArguments?.(huge);
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("(arguments truncated)");
			expect(message.length).toBeLessThan(3_500);
			expect(message).not.toContain("x".repeat(3_000));
		}
	});

	it("keeps small received arguments intact", () => {
		const wrapped = wrapToolDefinition(definition());
		try {
			wrapped.prepareArguments?.({ tasks: "nope" });
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("Received arguments:");
			expect(message).toContain('"tasks": "nope"');
			expect(message).not.toContain("(arguments truncated)");
		}
	});

	it("produces no hints for non-object arguments but keeps the validator report", () => {
		const wrapped = wrapToolDefinition(definition());
		try {
			wrapped.prepareArguments?.("nope");
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain('Validation failed for tool "batch":');
			expect(message).not.toContain("Hint:");
		}
	});

	it("does not stack hints when a synthesized definition is wrapped again", () => {
		const once = wrapToolDefinition(definition());
		const synthesized = createToolDefinitionFromAgentTool(once);
		const twice = wrapToolDefinition(synthesized);
		try {
			twice.prepareArguments?.({ tasks: [{ prompt: "Audit.", prompt_extra: "briefing" }] });
			expect.unreachable("validation should have failed");
		} catch (error) {
			const message = (error as Error).message;
			expect(message.split("Hint: ").length - 1).toBe(1);
		}
	});

	it("wraps every definition in a batch", () => {
		const wrapped = wrapToolDefinitions([definition(), definition({ name: "other" })]);
		expect(wrapped).toHaveLength(2);
		for (const tool of wrapped) {
			expect(() => tool.prepareArguments?.({ timeout: 1 })).toThrow(/Hint: timeout is not a field/);
		}
	});
});
