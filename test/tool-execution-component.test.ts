import { join, resolve } from "node:path";
import { resetCapabilitiesCache, setCapabilities, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import todo from "../src/extensions/todo/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/tool-view/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(requestRender: () => void = () => {}): TUI {
	return {
		requestRender,
	} as unknown as TUI;
}

function createTodoToolDefinition(): ToolDefinition {
	let definition: ToolDefinition | undefined;
	const api = {
		registerTool: (tool: ToolDefinition) => {
			definition = tool;
		},
		registerCommand: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	todo(api);
	if (!definition) throw new Error("todo tool was not registered");
	return definition;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetCapabilitiesCache();
	});

	// Issue #8577: ignore conversions that finish after the image was replaced.
	test("keeps the final tool image when a partial image conversion finishes late", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let finishConversion!: (result: { data: string; mimeType: string }) => void;
		const conversion = new Promise<{ data: string; mimeType: string }>((resolve) => {
			finishConversion = resolve;
		});
		vi.spyOn(imageConvert, "convertToPng").mockReturnValue(conversion);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-image-race",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult(
			{ content: [{ type: "image", data: "partial-jpeg", mimeType: "image/jpeg" }], isError: false },
			true,
		);
		component.updateResult({
			content: [{ type: "image", data: "final-png", mimeType: "image/png" }],
			isError: false,
		});
		expect(component.render(120).join("\n")).toContain("final-png");

		finishConversion({ data: "converted-partial", mimeType: "image/png" });
		await conversion;

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("final-png");
		expect(rendered).not.toContain("converted-partial");
	});

	test("ignores stale and post-disposal image conversions", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const conversions: Array<{
			resolve: (value: { data: string; mimeType: string } | null) => void;
		}> = [];
		vi.spyOn(imageConvert, "convertToPng").mockImplementation(
			() =>
				new Promise((resolveConversion) => {
					conversions.push({ resolve: resolveConversion });
				}),
		);
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-image-lifecycle",
			{},
			{},
			createBaseToolDefinition(),
			createFakeTui(requestRender),
			process.cwd(),
		);

		component.updateResult(
			{ content: [{ type: "image", data: "old-image", mimeType: "image/jpeg" }], isError: false },
			true,
		);
		component.updateResult(
			{ content: [{ type: "image", data: "new-image", mimeType: "image/jpeg" }], isError: false },
			true,
		);
		expect(conversions).toHaveLength(2);

		conversions[0]!.resolve({ data: "old-png", mimeType: "image/png" });
		await Promise.resolve();
		expect(requestRender).not.toHaveBeenCalled();

		conversions[1]!.resolve({ data: "new-png", mimeType: "image/png" });
		await Promise.resolve();
		expect(requestRender).toHaveBeenCalledTimes(1);

		component.updateResult(
			{ content: [{ type: "image", data: "final-image", mimeType: "image/jpeg" }], isError: false },
			true,
		);
		expect(conversions).toHaveLength(3);
		component.dispose();
		conversions[2]!.resolve({ data: "final-png", mimeType: "image/png" });
		await Promise.resolve();
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	test("refreshes self-scheduled renderers without adding generic progress", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const requestRender = vi.fn();
		let resultRenderCount = 0;
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderResult: (_result, options, _theme, context) => {
				resultRenderCount++;
				const state: { refreshTimer?: ReturnType<typeof setTimeout> } = context.state;
				if (options.isPartial) {
					if (state.refreshTimer === undefined) {
						state.refreshTimer = setTimeout(() => {
							state.refreshTimer = undefined;
							context.invalidate();
						}, 1000);
					}
				} else if (state.refreshTimer !== undefined) {
					clearTimeout(state.refreshTimer);
					state.refreshTimer = undefined;
				}
				return new Text(`elapsed ${Date.now()}ms`, 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-live-refresh",
			{},
			{},
			toolDefinition,
			createFakeTui(requestRender),
			process.cwd(),
		);

		component.markExecutionStarted();
		component.updateResult({ content: [], details: {}, isError: false }, true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("elapsed 0ms");
		const initialRenderCount = resultRenderCount;

		vi.advanceTimersByTime(3000);
		const refreshed = stripAnsi(component.render(120).join("\n"));
		expect(refreshed).toContain("elapsed 3000ms");
		expect(refreshed).not.toContain("Running…");
		expect(resultRenderCount).toBe(initialRenderCount + 3);

		component.updateResult({ content: [], details: {}, isError: false }, false);
		const finalRenderCount = resultRenderCount;
		const finalRenderRequests = requestRender.mock.calls.length;
		vi.advanceTimersByTime(3000);
		expect(resultRenderCount).toBe(finalRenderCount);
		expect(requestRender).toHaveBeenCalledTimes(finalRenderRequests);
	});

	test("disposes idempotently and stops self-scheduled refreshes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const requestRender = vi.fn();
		let resultRenderCount = 0;
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderResult: (_result, _options, _theme, context) => {
				resultRenderCount++;
				const state: { refreshTimer?: ReturnType<typeof setTimeout> } = context.state;
				if (state.refreshTimer === undefined) {
					state.refreshTimer = setTimeout(() => {
						state.refreshTimer = undefined;
						context.invalidate();
					}, 1000);
				}
				return new Text("live", 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-disposed-refresh",
			{},
			{},
			toolDefinition,
			createFakeTui(requestRender),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const initialRenderCount = resultRenderCount;

		vi.advanceTimersByTime(1000);
		expect(resultRenderCount).toBe(initialRenderCount + 1);

		component.dispose();
		component.dispose();
		const disposedRenderCount = resultRenderCount;
		const disposedRenderRequests = requestRender.mock.calls.length;
		vi.advanceTimersByTime(1000);
		expect(resultRenderCount).toBe(disposedRenderCount);
		expect(requestRender).toHaveBeenCalledTimes(disposedRenderRequests);
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("● custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("● custom call");
		expect(rendered).toContain("│ custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			withBuiltInRenderers("edit", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n│[^\S\n]*\n│ \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n│[^\S\n]*\n│[^\S\n]*\n│ \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	// Issue #9996: strict tool schemas make models send null for omitted optional fields.
	test("renders read calls with null offset and limit as full-file reads", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-null-range",
			{ path: "src/example.ts", offset: null, limit: null },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read src/example.ts");
		expect(rendered).not.toContain("src/example.ts:");
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			withBuiltInRenderers("read", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			withBuiltInRenderers("read", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("passes partial and completed results to call renderers", () => {
		type ResultDetails = { marker: string };
		const parameters = Type.Object({});
		const observations: Array<{ isPartial: boolean; marker: string | undefined; content: string | undefined }> = [];
		const toolDefinition: ToolDefinition<typeof parameters, ResultDetails> = {
			name: "custom_tool",
			label: "custom tool",
			description: "custom tool",
			parameters,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { marker: "unused" } }),
			renderCall: (_args, _theme, context) => {
				const firstContent = context.result?.content[0];
				observations.push({
					isPartial: context.isPartial,
					marker: context.result?.details.marker,
					content: firstContent?.type === "text" ? firstContent.text : undefined,
				});
				return new Text("call", 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-result-context",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "partial output" }], details: { marker: "partial" }, isError: false },
			true,
		);
		component.updateResult(
			{ content: [{ type: "text", text: "final output" }], details: { marker: "final" }, isError: false },
			false,
		);

		expect(observations).toContainEqual({ isPartial: true, marker: "partial", content: "partial output" });
		expect(observations).toContainEqual({ isPartial: false, marker: "final", content: "final output" });
	});

	test("expands fallback arguments without truncating their values", () => {
		const longValue = "x".repeat(200);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-expanded-args",
			{ query: "pi", long: longValue },
			{},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(300).join("\n"))).not.toContain(longValue);
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(300).join("\n"));
		expect(expanded).toContain("query: pi");
		expect(expanded).toContain(longValue);
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain('● custom_tool(foo="bar")');
		expect(rendered).toContain("│ done");
	});

	test("collapses generic result output until expanded", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-generic-collapse",
			{},
			{},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).not.toContain("line 5");
		expect(collapsed).toContain("line 6");
		expect(collapsed).toContain("line 15");
		expect(collapsed).toContain("5 earlier lines");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("line 15");
		expect(expanded).not.toContain("earlier lines");
	});

	test("applies native tool chrome to historical tools without a current definition", () => {
		const component = new ToolExecutionComponent(
			"historical_tool",
			"tool-historical",
			{ query: "docs" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "not available" }], isError: true }, false);

		const renderedLines = component.render(120);
		const rendered = stripAnsi(renderedLines.join("\n"));
		expect(rendered).toContain('● historical_tool(query="docs")');
		expect(rendered).toContain("│ not available");
		expect(rendered.match(/●/g)).toHaveLength(1);
		expect(renderedLines.find((line) => stripAnsi(line).includes("historical_tool"))).toContain(
			theme.fg("error", "●"),
		);
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("expands a collapsed tool result when clicked", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-click-expand",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);
		const width = 120;
		const lines = component.render(width);
		const resultRow = lines.findIndex((line) => stripAnsi(line).includes("notes.txt"));
		expect(resultRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y: resultRow,
			screenX: 2,
			screenY: resultRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).toContain("hidden content");
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	test("shows a collapsed todo row as one result-aware line and the result text only when expanded", () => {
		const todoDefinition = createTodoToolDefinition();
		const created = new ToolExecutionComponent(
			"todo",
			"todo-created",
			{
				create: [
					{ subject: "Wire parser", description: "Parser handles config" },
					{ subject: "Test parser", description: "Parser tests pass" },
				],
			},
			{},
			todoDefinition,
			createFakeTui(),
			process.cwd(),
		);
		created.updateResult(
			{
				content: [{ type: "text", text: "Created 2 tasks" }],
				details: {
					schemaVersion: 3,
					change: { created: [4, 5], updated: [], deleted: [], absent: [], evicted: [] },
					state: {
						items: [
							{ id: 4, subject: "Wire parser", description: "Parser handles config", status: "pending" },
							{ id: 5, subject: "Test parser", description: "Parser tests pass", status: "pending" },
						],
						nextId: 6,
					},
				},
				isError: false,
			},
			false,
		);
		const collapsed = stripAnsi(created.render(500).join("\n"));
		expect(collapsed).toContain("● todo created #4–#5 · Wire parser, Test parser");
		expect(collapsed).not.toContain("Created 2 tasks");
		created.setExpanded(true);
		expect(stripAnsi(created.render(500).join("\n"))).toContain("│ Created 2 tasks");

		const failed = new ToolExecutionComponent(
			"todo",
			"todo-failed",
			{ update: [{ id: 7 }] },
			{},
			todoDefinition,
			createFakeTui(),
			process.cwd(),
		);
		failed.updateResult(
			{ content: [{ type: "text", text: `bad request\n${"x".repeat(500)}` }], isError: true },
			false,
		);
		const failedRows = stripAnsi(failed.render(500).join("\n"));
		expect(failedRows).toContain("todo update #7 failed: bad request");
		expect(failedRows).not.toContain("x".repeat(200));
		expect(failedRows.split("\n").filter((line) => line.includes("todo update #7"))).toHaveLength(1);
		expect(failed.render(500).join("\n")).toContain(theme.fg("error", "●"));
	});

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});
