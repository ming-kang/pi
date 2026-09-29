import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { EMPTY_TODO_STATE, type TodoItem, type TodoState, type TodoStatus } from "../src/extensions/todo/schema.ts";
import {
	formatCommandList,
	formatTodoCall,
	formatTodoContent,
	formatTodoSummary,
	renderWidgetLine,
	type TodoSummaryContext,
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
		expect(line).toBe("Todos 2/6 · [>] #4 Four  [ ] #2 Two  [ ] #3 Three  [ ] #5 Five");
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
		const more = Number(line.match(/\+(\d+) more/)?.[1] ?? 0);
		expect(shown + more).toBe(4);
	});

	test("counts only hidden open tasks and truncates only the active subject", () => {
		const widgetState = state([
			item(1, "Done one", "completed"),
			item(2, "Active subject that is really quite long", "in_progress"),
			item(3, "Pending three subject"),
			item(4, "Pending four subject"),
			item(5, "Pending five subject"),
			item(6, "Pending six subject"),
		]);
		// Completed tasks do not count toward the overflow.
		expect(stripAnsi(renderWidgetLine(widgetState, theme, 120)[0]!)).toBe(
			"Todos 1/6 · [>] #2 Active subject that is really quite long  [ ] #3 Pending three subject  +3 more",
		);
		// Narrower: whole pending segments are dropped.
		expect(stripAnsi(renderWidgetLine(widgetState, theme, 62)[0]!)).toBe(
			"Todos 1/6 · [>] #2 Active subject that is really qui…  +4 more",
		);
		// Narrowest: the active subject truncates down to the last column.
		expect(stripAnsi(renderWidgetLine(widgetState, theme, 60)[0]!)).toBe(
			"Todos 1/6 · [>] #2 Active subject that is really q…  +4 more",
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
				expect(line).not.toContain("completed");
				if (width >= 40) {
					const shown = (stripAnsi(line).match(/\[[> ]\] #\d+/g) ?? []).length;
					const hidden = Number(stripAnsi(line).match(/\+(\d+) more/)?.[1] ?? 0);
					expect(shown + hidden).toBe(3);
				}
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
	const noChange = { created: [], updated: [], deleted: [], absent: [], evicted: [] };

	test("summarizes creates, updates, demotion, deletes, absences, and evictions", () => {
		expect(formatTodoContent({ ...noChange, created: [1, 3] }, contentState)).toBe(
			"Created 2 tasks: #1: Alpha; #3: Gamma",
		);
		expect(formatTodoContent({ ...noChange, created: [2] }, contentState)).toBe(
			"Created 1 task: #2: Beta (in_progress)",
		);
		expect(
			formatTodoContent({ ...noChange, updated: [{ id: 2, from: "pending", to: "in_progress" }] }, contentState),
		).toBe("Updated #2 (pending -> in_progress): Beta");
		expect(
			formatTodoContent(
				{ ...noChange, updated: [{ id: 2, from: "pending", to: "in_progress" }], demotedId: 1 },
				contentState,
			),
		).toBe("Updated #2 (pending -> in_progress): Beta; demoted #1 to pending");
		expect(
			formatTodoContent({ ...noChange, updated: [{ id: 1, from: "pending", to: "pending" }] }, contentState),
		).toBe("Updated #1: Alpha");
		expect(
			formatTodoContent(
				{
					...noChange,
					deleted: [
						{ id: 1, subject: "Alpha" },
						{ id: 3, subject: "Gamma" },
					],
				},
				contentState,
			),
		).toBe("Deleted 2 tasks: #1: Alpha; #3: Gamma");
		expect(formatTodoContent({ ...noChange, absent: [9] }, contentState)).toBe("#9 already absent");
		expect(
			formatTodoContent(
				{
					...noChange,
					evicted: [
						{ id: 1, subject: "Alpha" },
						{ id: 2, subject: "Beta" },
						{ id: 3, subject: "Gamma" },
					],
				},
				contentState,
			),
		).toBe("auto-removed completed #1–#3 to stay within 20");
	});

	test("joins a combined patch into one summary line", () => {
		const after = state([item(1, "Alpha", "completed"), item(2, "Beta", "in_progress"), item(4, "Fresh", "pending")]);
		expect(
			formatTodoContent(
				{
					created: [4],
					updated: [
						{ id: 1, from: "in_progress", to: "completed" },
						{ id: 2, from: "pending", to: "in_progress" },
					],
					deleted: [{ id: 3, subject: "Gamma" }],
					absent: [9],
					evicted: [],
				},
				after,
			),
		).toBe(
			"Created 1 task: #4: Fresh; Updated #1 (in_progress -> completed): Alpha; Updated #2 (pending -> in_progress): Beta; Deleted 1 task: #3: Gamma; #9 already absent",
		);
	});

	test("a change-free call returns the full list", () => {
		expect(formatTodoContent(noChange, contentState)).toBe(
			"Todos: 1 in progress, 2 pending, 0 completed\n" +
				"[>] #2 Beta\n    Do it\n" +
				"[ ] #1 Alpha\n    Do it\n" +
				"[ ] #3 Gamma\n    Do it",
		);
		expect(formatTodoContent(noChange, EMPTY_TODO_STATE)).toBe("No todos.");
	});
});

describe("formatTodoCall", () => {
	test("collapses to a one-line headline", () => {
		expect(
			formatTodoCall(
				{
					create: [
						{ subject: "Fix login redirect", description: "Auth tests pass" },
						{ subject: "Test parser", description: "Parser tests pass" },
					],
				},
				theme,
				false,
			),
		).toBe("todo create 2 tasks · Fix login redirect, Test parser");
		expect(formatTodoCall({ update: [{ id: 2, status: "in_progress" }] }, theme, false)).toBe(
			"todo update #2 in_progress",
		);
		expect(formatTodoCall({ delete: [3, 7] }, theme, false)).toBe("todo delete #3, #7");
		expect(formatTodoCall({}, theme, false)).toBe("todo list");
		expect(formatTodoCall({ create: [], update: [], delete: [] }, theme, false)).toBe("todo list");
	});

	test("renders a combined patch as verb segments", () => {
		expect(
			formatTodoCall(
				{
					create: [{ subject: "Fresh task", description: "Do it" }],
					update: [
						{ id: 1, status: "completed" },
						{ id: 2, status: "in_progress" },
					],
					delete: [9],
				},
				theme,
				false,
			),
		).toBe("todo create 1 task · Fresh task ; update #1 completed, #2 in_progress ; delete #9");
	});

	test("previews at most two subjects and caps create batches at the maximum", () => {
		const five = {
			create: Array.from({ length: 5 }, (_, index) => ({ subject: `Task ${index + 1}`, description: "Do it" })),
		};
		expect(formatTodoCall(five, theme, false)).toBe("todo create 5 tasks · Task 1, Task 2, +3 more");
		const oversized = {
			create: Array.from({ length: 25 }, (_, index) => ({ subject: `Task ${index + 1}`, description: "Do it" })),
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
		expect(formatTodoCall({ create: items }, theme, false)).toBe("todo create 3 tasks · Beta, Gamma, +1 more");
	});

	test("expanded create shows per-item subjects, indented descriptions, and result ids", () => {
		const args = {
			create: [
				{ subject: "Wire parser", description: "Parser handles config" },
				{ subject: "Test parser", description: "Parser tests pass" },
			],
		};
		const result = {
			content: [],
			details: {
				schemaVersion: 3,
				change: { created: [4, 5], updated: [], deleted: [], absent: [], evicted: [] },
				state: { items: [item(4, "Wire parser"), item(5, "Test parser")], nextId: 6 },
			},
		};
		expect(formatTodoCall(args, theme, true, result)).toBe(
			"todo create 2 tasks · Wire parser, Test parser\n#4 Wire parser\n    Parser handles config\n#5 Test parser\n    Parser tests pass",
		);
	});

	test("expanded create marks a non-pending status on the item line", () => {
		const args = {
			create: [{ subject: "Wire parser", description: "Parser handles config", status: "in_progress" }],
		};
		const result = {
			content: [],
			details: {
				schemaVersion: 3,
				change: { created: [4], updated: [], deleted: [], absent: [], evicted: [] },
				state: { items: [item(4, "Wire parser", "in_progress")], nextId: 5 },
			},
		};
		expect(formatTodoCall(args, theme, true, result)).toBe(
			"todo create 1 task · Wire parser\n#4 Wire parser (in_progress)\n    Parser handles config",
		);
	});

	test("expanded update shows the replacement description bounded to 120 characters", () => {
		const lines = formatTodoCall(
			{ update: [{ id: 2, status: "in_progress", description: "x".repeat(140) }] },
			theme,
			true,
		).split("\n");
		expect(lines[0]).toBe("todo update #2 in_progress");
		expect(lines[1]).toBe(`    ${"x".repeat(119)}…`);
	});

	test("expanded delete names removed tasks and absent ids instead of repeating the headline", () => {
		const args = { delete: [3, 7] };
		// The headline already carries the ids, so an unsettled call adds no detail line.
		expect(formatTodoCall(args, theme, true)).toBe("todo delete #3, #7");

		const result = {
			content: [],
			details: {
				schemaVersion: 3,
				change: {
					created: [],
					updated: [],
					deleted: [{ id: 3, subject: "Remove legacy task" }],
					absent: [7],
					evicted: [],
				},
				state: { items: [], nextId: 8 },
			},
		};
		expect(formatTodoCall(args, theme, true, result)).toBe(
			"todo delete #3, #7\n#3 Remove legacy task\n#7 already absent",
		);
	});

	test("tolerates partial, sparse, and hostile args and details", () => {
		expect(formatTodoCall(undefined, theme, false)).toBe("todo list");
		expect(formatTodoCall({ create: "nope" }, theme, true)).toBe("todo create");
		expect(formatTodoCall({ update: [{ id: -1, status: "bogus", subject: 42 }] }, theme, false)).toBe("todo update");
		expect(formatTodoCall({ delete: [1.5, -2, "x"] }, theme, false)).toBe("todo delete");

		const sparseItems: unknown[] = new Array(2);
		sparseItems[1] = { subject: "Valid item", description: "Still renders" };
		const sparse = formatTodoCall({ create: sparseItems }, theme, true);
		expect(sparse).toContain("2 tasks");
		expect(sparse).toContain("1. Valid item");

		expect(
			formatTodoCall({ create: [{ subject: "A", description: "d" }] }, theme, true, {
				content: [],
				details: "garbage",
			}),
		).toBe("todo create 1 task · A\n1. A\n    d");

		const hostileText = formatTodoCall(
			{ create: [{ subject: "x".repeat(10_000), description: "y".repeat(10_000) }] },
			theme,
			true,
		);
		expect(hostileText.length).toBeLessThan(600);
		expect(hostileText).not.toContain("x".repeat(161));
		expect(hostileText).not.toContain("y".repeat(121));
	});
});

describe("formatTodoSummary", () => {
	function completed(details: unknown): TodoSummaryContext {
		return { isError: false, isPartial: false, result: { content: [], details } };
	}
	const noChange = { created: [], updated: [], deleted: [], absent: [], evicted: [] };

	test("summarizes every v3 change part from result details", () => {
		const summaryState = state([
			item(1, "One", "in_progress"),
			item(2, "Two", "pending"),
			item(3, "Three", "completed"),
		]);
		expect(
			formatTodoSummary(
				{
					create: [
						{ subject: "Wire parser", description: "d" },
						{ subject: "Test parser", description: "d" },
					],
				},
				theme,
				completed({
					schemaVersion: 3,
					change: { ...noChange, created: [4, 5] },
					state: { items: [item(4, "Wire parser"), item(5, "Test parser")], nextId: 6 },
				}),
			),
		).toBe("todo created #4–#5 · Wire parser, Test parser");
		expect(
			formatTodoSummary(
				{ create: [] },
				theme,
				completed({
					schemaVersion: 3,
					change: { ...noChange, created: [2, 5] },
					state: { items: [item(2, "Alpha"), item(5, "Beta")], nextId: 6 },
				}),
			),
		).toBe("todo created #2, #5 · Alpha, Beta");
		expect(
			formatTodoSummary(
				{ update: [{ id: 4, status: "in_progress" }] },
				theme,
				completed({
					schemaVersion: 3,
					change: { ...noChange, updated: [{ id: 4, from: "pending", to: "in_progress" }], demotedId: 2 },
					state: { items: [item(2, "Second", "pending"), item(4, "Fourth", "in_progress")], nextId: 5 },
				}),
			),
		).toBe("todo updated #4 in_progress Fourth ; demoted #2");
		expect(formatTodoSummary({}, theme, completed({ schemaVersion: 3, change: noChange, state: summaryState }))).toBe(
			"todo list: 1 in progress, 1 pending, 1 completed",
		);
		expect(
			formatTodoSummary(
				{ delete: [3] },
				theme,
				completed({
					schemaVersion: 3,
					change: { ...noChange, deleted: [{ id: 3, subject: "Remove legacy task" }] },
					state: summaryState,
				}),
			),
		).toBe("todo deleted #3 · Remove legacy task");
		expect(
			formatTodoSummary(
				{ delete: [3, 9] },
				theme,
				completed({
					schemaVersion: 3,
					change: { ...noChange, deleted: [{ id: 3, subject: "Remove legacy task" }], absent: [9] },
					state: summaryState,
				}),
			),
		).toBe("todo deleted #3 · Remove legacy task ; #9 already absent");
		expect(
			formatTodoSummary(
				{ create: [{ subject: "Fresh", description: "d" }] },
				theme,
				completed({
					schemaVersion: 3,
					change: {
						created: [21],
						updated: [],
						deleted: [],
						absent: [],
						evicted: [
							{ id: 1, subject: "Done 1" },
							{ id: 2, subject: "Done 2" },
						],
					},
					state: { items: [item(21, "Fresh")], nextId: 22 },
				}),
			),
		).toBe("todo created #21 · Fresh ; auto-removed #1, #2");
	});

	test("bounds summary errors to one line of at most 120 characters", () => {
		const failure = formatTodoSummary({ update: [{ id: 7 }] }, theme, {
			isError: true,
			isPartial: false,
			result: { content: [{ type: "text", text: `bad request\n${"x".repeat(500)}` }], details: undefined },
		});
		expect(failure).toMatch(/^todo update #7 failed: bad request/);
		expect(failure).not.toContain("\n");
		expect(failure).not.toContain("x".repeat(200));
		expect(failure.length).toBeLessThanOrEqual("todo update #7 failed: ".length + 120);
	});

	test("falls back for partial, v2, and hostile details without throwing", () => {
		const v3Create = {
			schemaVersion: 3,
			change: { created: [1], updated: [], deleted: [], absent: [], evicted: [] },
			state: { items: [item(1, "A")], nextId: 2 },
		};
		expect(
			formatTodoSummary({}, theme, {
				isError: false,
				isPartial: true,
				result: { content: [], details: v3Create },
			}),
		).toBe("todo list");

		const v2 = { schemaVersion: 2, change: { kind: "create", ids: [1] }, state: { items: [], nextId: 2 } };
		expect(formatTodoSummary({ create: [{ subject: "A", description: "d" }] }, theme, completed(v2))).toBe(
			"todo create 1 task · A",
		);

		expect(
			formatTodoSummary({}, theme, completed({ schemaVersion: 3, change: noChange, state: { items: "nope" } })),
		).toBe("todo list");

		const hostile: unknown[] = [
			undefined,
			"garbage",
			{ schemaVersion: 3 },
			{ schemaVersion: 3, change: null, state: { items: [] } },
			{ schemaVersion: 3, change: { created: "nope" }, state: { items: [] } },
			{ schemaVersion: 3, change: { created: [1] }, state: { items: "nope" } },
			{ schemaVersion: 3, change: { updated: [{ id: 1.5 }] }, state: { items: [] } },
			{ schemaVersion: 3, change: noChange, state: { items: Array.from({ length: 10_001 }, () => ({})) } },
		];
		for (const details of hostile) {
			expect(() => formatTodoSummary({}, theme, completed(details))).not.toThrow();
		}
	});
});
