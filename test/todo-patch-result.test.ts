import { describe, expect, it } from "vitest";
import { createTodoStore, replayTodosFromBranch } from "../src/extensions/todo/state.ts";
import { formatTodoContent } from "../src/extensions/todo/view.ts";

describe("todo final patch results", () => {
	it.each(["create", "update"] as const)("reports the final status when %s activates another task", (activation) => {
		const store = createTodoStore();
		store.execute({
			create: [
				{ subject: "First", description: "First done", status: "in_progress" },
				{ subject: "Second", description: "Second done" },
			],
		});
		const details = store.execute(
			activation === "create"
				? {
						update: [{ id: 1, subject: "Renamed" }],
						create: [{ subject: "Third", description: "Third done", status: "in_progress" }],
					}
				: {
						update: [
							{ id: 1, subject: "Renamed" },
							{ id: 2, status: "in_progress" },
						],
					},
		);
		expect(details.change.updated).toContainEqual({ id: 1, from: "in_progress", to: "pending" });
		expect(details.change.demotedId).toBe(1);
		expect(formatTodoContent(details.change, details.state)).toContain(
			"Updated #1 (in_progress -> pending): Renamed",
		);
		expect(
			replayTodosFromBranch({
				sessionManager: {
					getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details } }],
				},
			}),
		).toEqual(store.getState());
	});

	it("explains protected completed tasks and allows retry by deleting one", () => {
		const store = createTodoStore();
		store.execute({
			create: Array.from({ length: 20 }, (_, index) => ({ subject: `Task ${index}`, description: "Verified" })),
		});
		store.execute({ update: [{ id: 1, status: "completed" }] });
		const before = store.getState();
		const create = [{ subject: "New task", description: "Verify new task" }];
		expect(() => store.execute({ update: [{ id: 1, subject: "Renamed" }], create })).toThrow(
			/created or updated.*not reclaimed/,
		);
		expect(() => store.execute({ update: [{ id: 1, subject: "Renamed" }], create })).toThrow(
			/Completed ids before this call: #1/,
		);
		expect(store.getState()).toEqual(before);
		const result = store.execute({ delete: [1], create });
		expect(result.change.created).toEqual([21]);
		expect(result.state.items).toHaveLength(20);
	});
});
