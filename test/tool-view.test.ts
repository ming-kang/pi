import { Container, Spacer, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { PendingToolMap, ToolChatContainer } from "../src/modes/interactive/tool-view/chat.ts";
import { FramedComponent, gutterWidth, toolStyle } from "../src/modes/interactive/tool-view/style.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/tool-view/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui(requestRender: () => void = () => {}): TUI {
	return { requestRender } as unknown as TUI;
}

function row(name: string, id: string, args: unknown, definition: unknown): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, args, {}, definition as ToolDefinition, fakeTui(), process.cwd());
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line).trimEnd());
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

describe("tool frame", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("hangs every line of one tool off the marker and rail", () => {
		const header = new FramedComponent(new Text("first\nsecond\n\nfourth", 0, 0), "header", () => "success");
		const body = new FramedComponent(new Text("\n\nbody one\n\nbody three", 0, 0), "body", () => "success");
		expect(plain([...header.render(40), ...body.render(40)])).toEqual([
			"● first",
			"│ second",
			"│",
			"│ fourth",
			"│ body one",
			"│",
			"│ body three",
		]);
	});

	test("drops blank lines directly under the marker line but keeps later ones", () => {
		const text = ["title", "", "", "preview one", "", "preview two"].join("\n");
		const header = new FramedComponent(new Text(text, 0, 0), "header", () => "success");
		expect(plain(header.render(40))).toEqual(["● title", "│ preview one", "│", "│ preview two"]);
	});

	test("colors the marker by status and reads the status when rendering", () => {
		let color: "warning" | "success" | "error" = "warning";
		const header = new FramedComponent(new Text("call", 0, 0), "header", () => color);
		expect(header.render(40)[0]).toContain(theme.fg("warning", "●"));
		color = "error";
		expect(header.render(40)[0]).toContain(theme.fg("error", "●"));
	});

	test("derives the gutter width from the glyphs instead of assuming two cells", () => {
		const original = toolStyle.marker.glyph;
		try {
			toolStyle.marker.glyph = "⬤";
			const width = gutterWidth();
			const header = new FramedComponent(new Text("x".repeat(80), 0, 0), "header", () => "success");
			const body = new FramedComponent(new Text("y".repeat(80), 0, 0), "body", () => "success");
			for (const line of [...header.render(30), ...body.render(30)]) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(30);
			}
			expect(visibleWidth(header.render(30)[0]!.slice(0, header.render(30)[0]!.indexOf("x")))).toBe(width);
			// The rail is padded to the marker's width so continuation lines stay aligned.
			expect(visibleWidth(body.render(30)[0]!.slice(0, body.render(30)[0]!.indexOf("y")))).toBe(width);
		} finally {
			toolStyle.marker.glyph = original;
		}
	});

	test("renders nothing for an empty component", () => {
		expect(new FramedComponent(new Text("", 0, 0), "body", () => "success").render(40)).toEqual([]);
	});
});

describe("compact transcript", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function transcript(): { chat: ToolChatContainer; rows: ToolExecutionComponent[] } {
		const chat = new ToolChatContainer();
		chat.addChild(new Text("Let me look.", 0, 0));
		const read = row(
			"read",
			"r1",
			{ path: "src/app.ts", offset: 1, limit: 80 },
			createReadToolDefinition(process.cwd()),
		);
		read.updateResult(textResult("file body"), false);
		const grep = row("grep", "g1", { pattern: "useState", path: "src" }, withBuiltInRenderers("grep", undefined));
		grep.updateResult(textResult("src/a.tsx:12: useState()"), false);
		const bash = row(
			"bash",
			"b1",
			{ command: "npm test" },
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
		);
		bash.updateResult(textResult("FAIL a.test.ts", true), false);
		for (const child of [read, grep, bash]) chat.addChild(child);
		chat.addChild(new Spacer(1));
		chat.addChild(new Text("Tests failed.", 0, 0));
		return { chat, rows: [read, grep, bash] };
	}

	test("puts no blank line between consecutive tools and one between tools and text", () => {
		const { chat } = transcript();
		expect(plain(chat.render(80))).toEqual([
			"Let me look.",
			"",
			"● read src/app.ts:1-80",
			"● grep /useState/ in src",
			"● $ npm test",
			"│ FAIL a.test.ts",
			"",
			"Tests failed.",
		]);
	});

	test("marks the state on the dot only", () => {
		const { chat } = transcript();
		const lines = chat.render(80);
		expect(lines.find((line) => stripAnsi(line).includes("src/app.ts"))).toContain(theme.fg("success", "●"));
		expect(lines.find((line) => stripAnsi(line).includes("npm test"))).toContain(theme.fg("error", "●"));
	});

	test("restores the blank line when a tool no longer follows a tool", () => {
		const { chat, rows } = transcript();
		chat.removeChild(rows[0]!);
		expect(plain(chat.render(80)).slice(0, 4)).toEqual([
			"Let me look.",
			"",
			"● grep /useState/ in src",
			"● $ npm test",
		]);
	});

	test("shows a pending tool with the pending dot and no progress row", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const bash = row(
			"bash",
			"b2",
			{ command: "sleep 30" },
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
		);
		bash.markExecutionStarted();
		bash.updateResult({ content: [], isError: false }, true);
		vi.advanceTimersByTime(5000);
		bash.invalidate();
		const lines = bash.render(80);
		expect(lines.join("\n")).toContain(theme.fg("warning", "●"));
		expect(stripAnsi(lines.join("\n"))).not.toContain("Running…");
		expect(stripAnsi(lines.join("\n"))).not.toContain("background");
		bash.dispose();
	});
});

describe("collapsed results", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function grepRow(): ToolExecutionComponent {
		return row("grep", "g2", { pattern: "todo" }, withBuiltInRenderers("grep", undefined));
	}

	test("shows only the header for a successful explore tool until expanded", () => {
		const component = grepRow();
		component.updateResult(textResult("src/a.ts:1: todo"), false);
		expect(plain(component.render(80)).join("\n")).not.toContain("src/a.ts");
		component.setExpanded(true);
		expect(plain(component.render(80)).join("\n")).toContain("│ src/a.ts:1: todo");
	});

	test("lets the style policy enable a bounded read preview", () => {
		const original = toolStyle.collapsed.headerOnly;
		try {
			toolStyle.collapsed.headerOnly = new Set([...original].filter((name) => name !== "read"));
			const component = row("read", "read-preview", { path: "notes.txt" }, createReadToolDefinition(process.cwd()));
			component.updateResult(
				textResult(Array.from({ length: 15 }, (_, index) => `read line ${index + 1}`).join("\n")),
			);
			const collapsed = plain(component.render(80)).join("\n");
			expect(collapsed).toContain("read line 1\n");
			expect(collapsed).toContain("read line 10\n");
			expect(collapsed).not.toContain("read line 11");
			expect(collapsed).toContain("5 more lines");
			component.setExpanded(true);
			expect(plain(component.render(80)).join("\n")).toContain("read line 15");
		} finally {
			toolStyle.collapsed.headerOnly = original;
		}
	});

	test.each([false, true])("discloses grep search options (expanded=%s)", (expanded) => {
		const component = row(
			"grep",
			"grep-options",
			{ pattern: "a.b", path: "src", glob: "*.ts", literal: true, ignoreCase: true, context: 2, limit: 10 },
			withBuiltInRenderers("grep", undefined),
		);
		component.setExpanded(expanded);
		const rendered = plain(component.render(100)).join("\n");
		for (const value of ["/a.b/", "src", "*.ts", "-i", "-F", "-C 2", "limit 10"]) {
			expect(rendered).toContain(value);
		}
		component.updateArgs({ pattern: "a.b", ignoreCase: false, literal: false, context: 0 });
		const defaults = plain(component.render(100)).join("\n");
		expect(defaults).not.toMatch(/-i|-F/);
		expect(defaults).toContain("-C 0");
	});

	test("shows the error of a failed explore tool even when collapsed", () => {
		const component = grepRow();
		component.updateResult(textResult("regex parse error", true), false);
		const lines = plain(component.render(80));
		expect(lines.some((line) => line === "│ regex parse error")).toBe(true);
		expect(component.render(80).join("\n")).toContain(theme.fg("error", "●"));
	});

	test("keeps a bounded tail for tools without a renderer", () => {
		const definition: ToolDefinition = {
			name: "custom_tool",
			label: "custom",
			description: "custom",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
		};
		const component = row("custom_tool", "c1", { q: 1 }, definition);
		component.updateResult(
			textResult(Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n")),
			false,
		);
		const collapsed = plain(component.render(80)).join("\n");
		expect(collapsed).toContain("● custom_tool(q=1)");
		expect(collapsed).toContain("5 earlier lines");
		expect(collapsed).toContain("line 15");
		expect(collapsed).not.toContain("line 5\n");
	});
});

describe("chat lifecycle", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("disposes rows when the chat or the pending map is cleared", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const definition: ToolDefinition = {
			name: "live",
			label: "live",
			description: "live",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderResult: (_result, _options, _theme, context) => {
				const state: { timer?: ReturnType<typeof setTimeout>; dispose?: () => void } = context.state;
				state.timer ??= setTimeout(() => {
					state.timer = undefined;
					context.invalidate();
				}, 1000);
				state.dispose = () => {
					if (state.timer) clearTimeout(state.timer);
					state.timer = undefined;
				};
				return new Text("live", 0, 0);
			},
		};
		const chatRow = new ToolExecutionComponent(
			"live",
			"l1",
			{},
			{},
			definition,
			fakeTui(requestRender),
			process.cwd(),
		);
		chatRow.updateResult({ content: [], details: {}, isError: false }, true);
		const chat = new ToolChatContainer();
		chat.addChild(chatRow);
		const pending = new PendingToolMap();
		pending.set("l1", chatRow);

		pending.clear();
		chat.clear();
		const requests = requestRender.mock.calls.length;
		vi.advanceTimersByTime(5000);
		expect(requestRender).toHaveBeenCalledTimes(requests);
		expect(chat.children).toHaveLength(0);
		expect(pending.size).toBe(0);
	});

	test("ignores non-row children when spacing rows", () => {
		const chat = new ToolChatContainer();
		chat.addChild(new Container());
		expect(chat.render(40)).toEqual([]);
	});
});
