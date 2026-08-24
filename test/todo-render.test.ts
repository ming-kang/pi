import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { EMPTY_TODO_STATE, type TodoItem, type TodoState, type TodoStatus } from "../src/extensions/todo/schema.ts";
import {
	formatCommandList,
	formatTodoCall,
	formatTodoContent,
	formatTodoGroupCall,
	renderWidgetLine,
	type TodoGroupRenderContext,
} from "../src/extensions/todo/view.ts";
import { initTheme, theme as realTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function item(id: number, subject: string, status: TodoStatus = "pending", description = "Do it"): TodoItem {
	return { id, subject, description, status };
}

function state(items: TodoItem[]): TodoState {
	return { items, nextId: Math.max(0, ...items.map((entry) => entry.id)) + 1 };
}

describe("renderWidgetLine", () => {
	test("returns no line without open tasks and exactly one otherwise", () => {
		expect(renderWidgetLine(EMPTY_TODO_STATE, theme, 120)).toEqual([]);
		expect(renderWidgetLine(state([item(1, "Done", "completed")]), theme, 120)).toEqual([]);
		expect(renderWidgetLine(state([item(1, "Open")]), theme, 120)).toHaveLength(1);
		expect(renderWidgetLine(state([item(1, "Active", "in_progress")]), theme, 120)).toHaveLength(1);
	});

	test("headers count completed over total and segments use the exact spacing form", () => {
		const widgetState = state([
			item(1, "One", "completed", "First done"),
			item(2, "Two", "pending", "Second work"),
			item(3, "Three", "pending", "Third work"),
			item(4, "Four", "in_progress", "Fourth work"),
			item(5, "Five", "pending", "Fifth work"),
			item(6, "Six", "completed", "Sixth done"),
		]);
		const line = stripAnsi(renderWidgetLine(widgetState, theme, 200)[0]!);
		// Header then " · ", segments separated by two spaces, no extra middle dots.
		expect(line).toBe("Todos 2/6 · [>] #4 Four  [ ] #2 Two  [ ] #3 Three  [ ] #5 Five  +2 more (2 completed)");
	});

	test("orders active first and pending by id, hides descriptions and completed segments", () => {
		const widgetState = state([
			item(1, "One", "completed", "First done"),
			item(2, "Two", "pending", "Second work"),
			item(3, "Three", "pending", "Third work"),
			item(4, "Four", "in_progress", "Fourth work"),
			item(5, "Five", "pending", "Fifth work"),
			item(6, "Six", "completed", "Sixth done"),
		]);
		const line = stripAnsi(renderWidgetLine(widgetState, theme, 200)[0]!);
		expect(line.indexOf("[>] #4")).toBeLessThan(line.indexOf("[ ] #3"));
		expect(line).not.toContain("First done");
		expect(line).not.toContain("Sixth done");
		expect(line).not.toMatch(/\[x\]/);
		const shown = (line.match(/\[[> ]\] #\d+/g) ?? []).length;
		const more = Number(line.match(/\+(\d+) more/)![1]);
		expect(shown + more).toBe(6);
	});

	test("drops whole pending segments, shortens the overflow, and truncates only the active subject", () => {
		const widgetState = state([
			item(1, "Done one", "completed"),
			item(2, "Active subject that is really quite long", "in_progress"),
			item(3, "Pending three subject"),
			item(4, "Pending four subject"),
			item(5, "Pending five subject"),
			item(6, "Pending six subject"),
		]);
		// Wide enough for the long overflow but not for every pending segment.
		expect(stripAnsi(renderWidgetLine(widgetState, theme, 120)[0]!)).toBe(
			"Todos 1/6 · [>] #2 Active subject that is really quite long  [ ] #3 Pending three subject  +4 more",
		);
		// Narrower: whole pending segments are dropped and the overflow shortens.
		expect(stripAnsi(renderWidgetLine(widgetState, theme, 62)[0]!)).toBe(
			"Todos 1/6 · [>] #2 Active subject that is really qui…  +5 more",
		);
		// Narrowest: the active subject truncates down to the last column.
		expect(stripAnsi(renderWidgetLine(widgetState, theme, 60)[0]!)).toBe(
			"Todos 1/6 · [>] #2 Active subject that is really q…  +5 more",
		);
		// Extreme widths still yield a single bounded line.
		expect(renderWidgetLine(widgetState, theme, 1).map(stripAnsi)).toEqual(["…"]);
		expect(renderWidgetLine(widgetState, theme, 0).map(stripAnsi)).toEqual(["…"]);
		expect(renderWidgetLine(widgetState, theme, 500)).toHaveLength(1);
	});

	test("every width from 1 to 200 yields at most one line that fits, CJK-safe", () => {
		const widgetState = state([
			item(1, "完成解析器接线", "completed", "配置解析全部通过"),
			item(2, "修复登录重定向处理", "in_progress", "认证测试通过"),
			item(3, "编写使用文档", "pending", "文档保持最新"),
			item(4, "验证导出格式", "pending", "导出结果一致"),
		]);
		for (let width = 1; width <= 200; width++) {
			const lines = renderWidgetLine(widgetState, theme, width);
			expect(lines.length).toBeLessThanOrEqual(1);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	describe("with the real dark theme", () => {
		beforeAll(() => initTheme("dark"));

		test("ANSI-styled output matches the identity form and stays within width", () => {
			const widgetState = state([
				item(1, "Done one", "completed"),
				item(2, "Active subject that is really quite long", "in_progress"),
				item(3, "Pending three subject"),
				item(4, "Pending four subject"),
				item(5, "Pending five subject"),
				item(6, "Pending six subject"),
			]);
			for (const width of [40, 62, 120, 200]) {
				const ansi = renderWidgetLine(widgetState, realTheme, width);
				const plain = renderWidgetLine(widgetState, theme, width);
				expect(ansi.map((line) => stripAnsi(line))).toEqual(plain.map((line) => stripAnsi(line)));
				for (const line of ansi) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});
	});
});

describe("formatCommandList", () => {
	test("reports an empty list", () => {
		expect(formatCommandList(EMPTY_TODO_STATE)).toBe("No todos.");
	});

	test("shows status counts, status ordering, and indented descriptions", () => {
		const listState = state([
			item(2, "Second", "pending", "Do the second thing"),
			item(3, "Third", "completed", "Third thing verified"),
			item(1, "First", "in_progress", "Do the first thing"),
		]);
		expect(formatCommandList(listState)).toBe(
			"Todos: 1 in progress, 1 pending, 1 completed\n" +
				"[>] #1 First\n    Do the first thing\n" +
				"[ ] #2 Second\n    Do the second thing\n" +
				"[x] #3 Third\n    Third thing verified",
		);
	});
});

describe("formatTodoContent", () => {
	const contentState = state([
		item(1, "Alpha", "pending"),
		item(2, "Beta", "in_progress"),
		item(3, "Gamma", "pending"),
	]);

	test("summarizes create, update, demotion, list, and delete", () => {
		expect(formatTodoContent({ kind: "create", ids: [1, 3] }, contentState)).toBe(
			"Created 2 tasks: #1: Alpha; #3: Gamma",
		);
		expect(formatTodoContent({ kind: "update", id: 2, from: "pending", to: "in_progress" }, contentState)).toBe(
			"Updated #2 (pending -> in_progress): Beta",
		);
		expect(
			formatTodoContent({ kind: "update", id: 2, from: "pending", to: "in_progress", demotedId: 1 }, contentState),
		).toBe("Updated #2 (pending -> in_progress): Beta; demoted #1 to pending");
		expect(formatTodoContent({ kind: "update", id: 1, from: "pending", to: "pending" }, contentState)).toBe(
			"Updated #1: Alpha",
		);
		expect(formatTodoContent({ kind: "list" }, contentState)).toBe(
			"Todos: 1 in progress, 2 pending, 0 completed\n" +
				"[>] #2 Beta\n    Do it\n" +
				"[ ] #1 Alpha\n    Do it\n" +
				"[ ] #3 Gamma\n    Do it",
		);
		expect(
			formatTodoContent(
				{
					kind: "delete",
					removed: [
						{ id: 1, subject: "Alpha" },
						{ id: 3, subject: "Gamma" },
					],
				},
				contentState,
			),
		).toBe("Deleted 2 tasks: #1: Alpha; #3: Gamma");
		expect(formatTodoContent({ kind: "list" }, EMPTY_TODO_STATE)).toBe("No todos.");
	});
});

describe("formatTodoCall", () => {
	test("collapses to a one-line headline", () => {
		expect(
			formatTodoCall(
				{
					action: "create",
					items: [
						{ subject: "Fix login redirect", description: "Auth tests pass" },
						{ subject: "Test parser", description: "Parser tests pass" },
					],
				},
				theme,
				false,
			),
		).toBe("todo create 2 tasks · Fix login redirect, Test parser");
		expect(formatTodoCall({ action: "update", id: 2, status: "in_progress" }, theme, false)).toBe(
			"todo update #2 in_progress",
		);
		expect(formatTodoCall({ action: "delete", ids: [3, 7] }, theme, false)).toBe("todo delete #3, #7");
		expect(formatTodoCall({ action: "list" }, theme, false)).toBe("todo list");
	});

	test("previews at most two subjects and caps create batches at the maximum", () => {
		const five = {
			action: "create",
			items: Array.from({ length: 5 }, (_, index) => ({ subject: `Task ${index + 1}`, description: "Do it" })),
		};
		expect(formatTodoCall(five, theme, false)).toBe("todo create 5 tasks · Task 1, Task 2, +3 more");
		const oversized = {
			action: "create",
			items: Array.from({ length: 25 }, (_, index) => ({ subject: `Task ${index + 1}`, description: "Do it" })),
		};
		expect(formatTodoCall(oversized, theme, false)).toBe("todo create 20 tasks · Task 1, Task 2, +18 more");
		const expanded = formatTodoCall(oversized, theme, true);
		expect(expanded).toContain("20. Task 20");
		expect(expanded).not.toContain("21. Task 21");
	});

	test("skips empty subjects when filling the two preview slots", () => {
		// Streaming args can deliver a later subject first; an empty one must not
		// consume a preview slot.
		const items = [
			{ subject: "", description: "" },
			{ subject: "Beta", description: "" },
			{ subject: "Gamma", description: "" },
		];
		expect(formatTodoCall({ action: "create", items }, theme, false)).toBe(
			"todo create 3 tasks · Beta, Gamma, +1 more",
		);
	});

	test("expanded create shows per-item subjects, indented descriptions, and result ids", () => {
		const args = {
			action: "create",
			items: [
				{ subject: "Wire parser", description: "Parser handles config" },
				{ subject: "Test parser", description: "Parser tests pass" },
			],
		};
		const result = {
			content: [],
			details: {
				schemaVersion: 2,
				change: { kind: "create", ids: [4, 5] },
				state: { items: [item(4, "Wire parser"), item(5, "Test parser")], nextId: 6 },
			},
		};
		expect(formatTodoCall(args, theme, true, result)).toBe(
			"todo create 2 tasks · Wire parser, Test parser\n#4 Wire parser\n    Parser handles config\n#5 Test parser\n    Parser tests pass",
		);
	});

	test("expanded update shows the replacement description bounded to 120 characters", () => {
		const lines = formatTodoCall(
			{ action: "update", id: 2, status: "in_progress", description: "x".repeat(140) },
			theme,
			true,
		).split("\n");
		expect(lines[0]).toBe("todo update #2 in_progress");
		expect(lines[1]).toBe(`    ${"x".repeat(119)}…`);
	});

	test("expanded delete names removed tasks instead of repeating the headline ids", () => {
		const args = { action: "delete", ids: [3, 7] };
		// The headline already carries the ids, so an unsettled call adds no detail line.
		expect(formatTodoCall(args, theme, true)).toBe("todo delete #3, #7");

		const result = {
			content: [],
			details: {
				schemaVersion: 2,
				change: {
					kind: "delete",
					removed: [
						{ id: 3, subject: "Remove legacy task" },
						{ id: 7, subject: "Drop unused flag" },
					],
				},
				state: { items: [], nextId: 8 },
			},
		};
		expect(formatTodoCall(args, theme, true, result)).toBe(
			"todo delete #3, #7\n#3 Remove legacy task\n#7 Drop unused flag",
		);

		// A create result never feeds the delete detail lines.
		expect(
			formatTodoCall(args, theme, true, {
				content: [],
				details: { schemaVersion: 2, change: { kind: "create", ids: [3] }, state: { items: [], nextId: 4 } },
			}),
		).toBe("todo delete #3, #7");
	});

	test("tolerates partial, sparse, and hostile args and details", () => {
		expect(formatTodoCall(undefined, theme, false)).toBe("todo");
		expect(formatTodoCall({}, theme, false)).toBe("todo");
		expect(formatTodoCall({ action: "create" }, theme, false)).toBe("todo create");
		expect(formatTodoCall({ action: "create", items: "nope" }, theme, true)).toBe("todo create");
		expect(formatTodoCall({ action: "update", id: -1, status: "bogus", subject: 42 }, theme, false)).toBe(
			"todo update",
		);
		expect(formatTodoCall({ action: "delete", ids: [1.5, -2, "x"] }, theme, false)).toBe("todo delete");

		const sparseItems: unknown[] = new Array(2);
		sparseItems[1] = { subject: "Valid item", description: "Still renders" };
		const sparse = formatTodoCall({ action: "create", items: sparseItems }, theme, true);
		expect(sparse).toContain("2 tasks");
		expect(sparse).toContain("1. Valid item");

		expect(
			formatTodoCall({ action: "create", items: [{ subject: "A", description: "d" }] }, theme, true, {
				content: [],
				details: "garbage",
			}),
		).toBe("todo create 1 task · A\n1. A\n    d");

		const hostileText = formatTodoCall(
			{ action: "create", items: [{ subject: "x".repeat(10_000), description: "y".repeat(10_000) }] },
			theme,
			true,
		);
		expect(hostileText.length).toBeLessThan(600);
		expect(hostileText).not.toContain("x".repeat(161));
		expect(hostileText).not.toContain("y".repeat(121));
	});
});

describe("formatTodoGroupCall", () => {
	function completed(details: unknown): TodoGroupRenderContext {
		return { isError: false, isPartial: false, result: { content: [], details } };
	}

	test("summarizes every v2 action from result details", () => {
		const groupState = state([
			item(1, "One", "in_progress"),
			item(2, "Two", "pending"),
			item(3, "Three", "completed"),
		]);
		expect(
			formatTodoGroupCall(
				{
					action: "create",
					items: [
						{ subject: "Wire parser", description: "d" },
						{ subject: "Test parser", description: "d" },
					],
				},
				theme,
				completed({
					schemaVersion: 2,
					change: { kind: "create", ids: [4, 5] },
					state: { items: [item(4, "Wire parser"), item(5, "Test parser")], nextId: 6 },
				}),
			),
		).toBe("todo created #4–#5 · Wire parser, Test parser");
		expect(
			formatTodoGroupCall(
				{ action: "create", items: [] },
				theme,
				completed({
					schemaVersion: 2,
					change: { kind: "create", ids: [2, 5] },
					state: { items: [item(2, "Alpha"), item(5, "Beta")], nextId: 6 },
				}),
			),
		).toBe("todo created #2, #5 · Alpha, Beta");
		expect(
			formatTodoGroupCall(
				{ action: "update", id: 4 },
				theme,
				completed({
					schemaVersion: 2,
					change: { kind: "update", id: 4, from: "pending", to: "in_progress", demotedId: 2 },
					state: { items: [item(2, "Second", "pending"), item(4, "Fourth", "in_progress")], nextId: 5 },
				}),
			),
		).toBe("todo updated #4 in_progress Fourth · demoted #2");
		expect(
			formatTodoGroupCall(
				{ action: "list" },
				theme,
				completed({ schemaVersion: 2, change: { kind: "list" }, state: groupState }),
			),
		).toBe("todo list: 1 in progress, 1 pending, 1 completed");
		expect(
			formatTodoGroupCall(
				{ action: "delete", ids: [3] },
				theme,
				completed({
					schemaVersion: 2,
					change: { kind: "delete", removed: [{ id: 3, subject: "Remove legacy task" }] },
					state: groupState,
				}),
			),
		).toBe("todo deleted #3 · Remove legacy task");
	});

	test("bounds group errors to one line of at most 120 characters", () => {
		const failure = formatTodoGroupCall({ action: "update", id: 7 }, theme, {
			isError: true,
			isPartial: false,
			result: { content: [{ type: "text", text: `bad request\n${"x".repeat(500)}` }], details: undefined },
		});
		expect(failure).toMatch(/^todo update #7 failed: bad request/);
		expect(failure).not.toContain("\n");
		expect(failure).not.toContain("x".repeat(200));
		expect(failure.length).toBeLessThanOrEqual("todo update #7 failed: ".length + 120);
	});

	test("falls back for partial, v1, and hostile details without throwing", () => {
		const v2Create = {
			schemaVersion: 2,
			change: { kind: "create", ids: [1] },
			state: { items: [item(1, "A")], nextId: 2 },
		};
		expect(
			formatTodoGroupCall({ action: "list" }, theme, {
				isError: false,
				isPartial: true,
				result: { content: [], details: v2Create },
			}),
		).toBe("todo list");

		const v1 = { schemaVersion: 1, action: "create", operation: { kind: "create", ids: [1] }, items: [], nextId: 2 };
		expect(
			formatTodoGroupCall({ action: "create", items: [{ subject: "A", description: "d" }] }, theme, completed(v1)),
		).toBe("todo create 1 task · A");

		expect(
			formatTodoGroupCall(
				{ action: "list" },
				theme,
				completed({ schemaVersion: 2, change: { kind: "list" }, state: { items: "nope" } }),
			),
		).toBe("todo list");

		const hostile: unknown[] = [
			undefined,
			"garbage",
			{ schemaVersion: 2 },
			{ schemaVersion: 2, change: null, state: { items: [] } },
			{ schemaVersion: 2, change: { kind: "create" }, state: { items: [] } },
			{ schemaVersion: 2, change: { kind: "create", ids: [0] }, state: { items: [] } },
			{ schemaVersion: 2, change: { kind: "create", ids: [1] }, state: { items: "nope" } },
			{ schemaVersion: 2, change: { kind: "update", id: 1.5 }, state: { items: [] } },
			{ schemaVersion: 2, change: { kind: "list" }, state: { items: Array.from({ length: 10_001 }, () => ({})) } },
			{ schemaVersion: 2, change: { kind: "weird" }, state: { items: [] } },
		];
		for (const details of hostile) {
			expect(() => formatTodoGroupCall({ action: "list" }, theme, completed(details))).not.toThrow();
		}
	});
});
