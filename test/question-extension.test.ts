import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolResultEventResult,
} from "../src/core/extensions/types.ts";
import { QUESTION_TOOL_NAME } from "../src/extensions/question/constants.ts";
import question from "../src/extensions/question/index.ts";
import type { QuestionParams } from "../src/extensions/question/schema.ts";
import type { DialogResult, QuestionToolDetails } from "../src/extensions/question/types.ts";

type QuestionTool = ToolDefinition<typeof QuestionParams, QuestionToolDetails>;
type EventHandler = (event: { toolName: string; details?: unknown }) => Promise<ToolResultEventResult | undefined>;

function setup(): { tool: QuestionTool; handlers: Map<string, EventHandler> } {
	let tool: QuestionTool | undefined;
	const handlers = new Map<string, EventHandler>();
	const pi = {
		registerTool: (definition: QuestionTool) => {
			tool = definition;
		},
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	question(pi);
	if (!tool) throw new Error("question tool was not registered");
	return { tool, handlers };
}

const params = {
	questions: [
		{
			question: "Which approach should we take?",
			header: "Approach",
			options: [
				{ label: "Alpha", description: "Use Alpha." },
				{ label: "Beta", description: "Use Beta." },
			],
		},
	],
};

describe("question extension protocol", () => {
	it("registers blocking dialogs for sequential execution", () => {
		const { tool } = setup();
		expect(tool.name).toBe(QUESTION_TOOL_NAME);
		expect(tool.executionMode).toBe("sequential");
	});

	it("maps only error outcomes to protocol-level tool errors", async () => {
		const { handlers } = setup();
		const handler = handlers.get("tool_result");
		if (!handler) throw new Error("tool_result handler was not registered");
		const details = (outcome: QuestionToolDetails["outcome"]): QuestionToolDetails => ({
			answers: [],
			outcome,
			cancelled: outcome === "cancelled",
		});
		await expect(handler({ toolName: QUESTION_TOOL_NAME, details: details("error") })).resolves.toEqual({
			isError: true,
		});
		for (const outcome of ["answered", "cancelled", "needs_clarification"] as const) {
			await expect(handler({ toolName: QUESTION_TOOL_NAME, details: details(outcome) })).resolves.toBeUndefined();
		}
		await expect(handler({ toolName: "other", details: details("error") })).resolves.toBeUndefined();
	});

	it("returns a structured error without the obsolete execute-level isError field when no TUI exists", async () => {
		const { tool } = setup();
		const result = await tool.execute("call-1", params, undefined, undefined, {
			hasUI: false,
			mode: "print",
		} as unknown as ExtensionContext);
		expect(result.details).toMatchObject({ outcome: "error", error: "no_ui" });
		expect(result).not.toHaveProperty("isError");
	});

	it("preserves answered dialog results through the sequential custom UI", async () => {
		const { tool } = setup();
		const dialogResult: DialogResult = {
			outcome: "answered",
			answers: [
				{
					questionIndex: 0,
					question: params.questions[0].question,
					header: params.questions[0].header,
					kind: "option",
					answer: "Alpha",
				},
			],
		};
		const result = await tool.execute("call-1", params, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			ui: { custom: async () => dialogResult },
		} as unknown as ExtensionContext);
		expect(result.details).toMatchObject({ outcome: "answered", answers: dialogResult.answers });
	});
});
