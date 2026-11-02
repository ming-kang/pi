import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { type CustomMessage, convertToLlm } from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { readVersionedTask } from "../src/core/tasks/codec.ts";
import { TASK_DETAILS_BYTES, TASK_RESULT_BYTES } from "../src/core/tasks/output.ts";
import {
	projectForModel,
	type TaskCompletionDetails,
	taskCompletionDetails,
	taskCompletionMessage,
} from "../src/core/tasks/presentation.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskSnapshot, TaskTerminalStatus } from "../src/core/tasks/types.ts";
import { renderTaskCompletion } from "../src/extensions/tasks/ui/completion-render.ts";
import { detailLines, outputLines } from "../src/extensions/tasks/ui/views.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { keyHint, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "bash-contract-task",
		kind: "bash",
		label: "Bash",
		output: "log",
		mode: "background",
		status: "completed",
		title: "npm run build",
		input: { label: "Command", text: "npm run build", truncated: false, language: "bash" },
		facts: [["Directory", "/project"]],
		toolCallId: "call",
		anchorId: null,
		startedAt: 10,
		endedAt: 20,
		outputPath: "/tmp/build.log",
		result: { text: "build output", truncated: false },
		...overrides,
	};
}

describe("background completion data contract", () => {
	it("saves the replayable task without human-only display or accounting", () => {
		const source = task({
			input: { label: "Command", text: "cat <<'EOF'\nOutput: /tmp/example.log\nEOF", truncated: false },
			status: "failed",
			error: "Arbitrary execution failure",
			display: { text: "human only", truncated: false },
		});
		const saved = taskCompletionMessage(source);
		const { display: _display, ...replayed } = source;
		expect(saved.details).toEqual({ version: 3, task: replayed });
		expect(saved.content).toContain("Arbitrary execution failure");
		expect(saved.content).toContain("Directory: /project");
		expect(saved.content).toContain("Output: /tmp/build.log");
		expect(saved.content).toContain("build output");
		expect(saved.content).not.toContain("human only");
		expect(saved.details).not.toHaveProperty("usage");
	});

	it("names every task by its title in the model-facing header", () => {
		const saved = taskCompletionMessage(
			task({
				id: "review-generic",
				kind: "review",
				label: "Review",
				title: "Inspect boundaries",
				input: undefined,
				facts: undefined,
				outputPath: undefined,
				result: { text: "Executor summary", truncated: false },
			}),
		);
		expect(saved.content).toContain("Background review review-generic: completed — Inspect boundaries");
		expect(saved.content).toContain("Executor summary");
	});

	it("appends a classified next-step hint to non-completed terminal notifications", () => {
		const cancelled = taskCompletionMessage(task({ status: "cancelled" }));
		expect(cancelled.content).toContain(
			"Next step: the task was cancelled — do not restart it unless the user asks.",
		);

		const timedOut = taskCompletionMessage(task({ status: "timeout" }));
		expect(timedOut.content).toContain("Next step: the task hit its timeout");

		const failed = taskCompletionMessage(task({ status: "failed" }));
		expect(failed.content).toContain("Next step: diagnose from the output above");

		const completed = taskCompletionMessage(task({ status: "completed" }));
		expect(completed.content).not.toContain("Next step:");
	});

	it("keeps the end of a long log, where its outcome is", () => {
		const output = `${"progress line\n".repeat(5000)}FINAL: 3 tests failed`;
		const saved = taskCompletionMessage(task({ result: { text: output, truncated: false } }));
		expect(saved.details?.task.result?.truncated).toBe(true);
		expect(saved.details?.task.result?.text.endsWith("FINAL: 3 tests failed")).toBe(true);
		expect(saved.content).toContain("FINAL: 3 tests failed");
		expect(Buffer.byteLength(String(saved.content))).toBeLessThan(12 * 1024);
		expect(saved.content).toContain("use tasks read");
	});

	it("delivers a background report whole, beginning first, as its foreground result would be", () => {
		const report = `## Summary\nKEY FINDING AT THE TOP\n\n${"detail line\n".repeat(1200)}## End\nLAST LINE`;
		const saved = taskCompletionMessage(
			task({
				id: "agent-report",
				kind: "agent",
				label: "Agent",
				output: "report",
				title: "Investigate",
				input: { label: "Prompt", text: "Investigate", truncated: false },
				outputPath: undefined,
				result: { text: report, truncated: false },
			}),
		);
		expect(Buffer.byteLength(report)).toBeGreaterThan(8 * 1024);
		expect(saved.content).toContain("KEY FINDING AT THE TOP");
		expect(saved.content).toContain("LAST LINE");
		expect(saved.content).not.toContain("Earlier output truncated");
		expect(saved.details?.task.result?.text.startsWith("## Summary")).toBe(true);
	});

	it("keeps the beginning of a report that exceeds the context budget", () => {
		const report = `TOP\n${"x".repeat(TASK_RESULT_BYTES)}\nBOTTOM`;
		const content = projectForModel(task({ output: "report", result: { text: report, truncated: false } }));
		expect(content).toContain("TOP");
		expect(content).not.toContain("BOTTOM");
		expect(content).toContain("[Saved output truncated; use tasks read for retained task details.]");
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(TASK_RESULT_BYTES);
	});

	it("records truncation when results or inputs are bounded by supervision", async () => {
		const service = new TaskRuntime({ enabled: true });
		try {
			const literal = "[Output truncated.]";
			await service.execute({
				kind: "bash",
				title: "Generic",
				toolCallId: "first",
				input: { label: "Command", text: "x".repeat(40_000), truncated: false },
				run: async () => ({
					result: { content: [{ type: "text", text: "界".repeat(50000) }], details: undefined },
				}),
			});
			const first = taskCompletionDetails(service.list()[0]!).task;
			expect(first.kind).toBe("bash");
			expect(first.result?.truncated).toBe(true);
			expect(first.input?.truncated).toBe(true);
			await service.execute({
				kind: "bash",
				title: "Literal",
				toolCallId: "second",
				run: async () => ({ result: { content: [{ type: "text", text: literal }], details: undefined } }),
			});
			expect(taskCompletionDetails(service.list()[1]!).task.result).toEqual({ text: literal, truncated: false });
		} finally {
			service.close();
		}
	});

	it("respects storage, context byte and line budgets with escape-heavy metadata and output", () => {
		const huge = '界🙂"\\\u0001\n'.repeat(30000);
		const service = new TaskRuntime({ enabled: true });
		const run = service.execute({
			kind: "bash",
			title: huge,
			input: { label: "Command", text: huge, truncated: false },
			facts: [["Directory", huge]],
			toolCallId: "escape",
			run: async () => ({ result: { content: [{ type: "text", text: huge }], details: undefined }, error: huge }),
		});
		return run.then(() => {
			const saved = taskCompletionMessage(service.list()[0]!);
			service.close();
			expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(TASK_DETAILS_BYTES);
			expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(TASK_RESULT_BYTES);
			expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
			expect(saved.content).toContain("[Earlier output truncated; use tasks read for retained task details.]");
			expect(readVersionedTask(JSON.parse(JSON.stringify(saved.details)))).toBeDefined();
		});
	});

	it("carries details through the session journal and sends only prose to the context", () => {
		const saved = taskCompletionMessage(task());
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomMessageEntry(saved.customType, saved.content, saved.display, saved.details);
		const entry = JSON.parse(JSON.stringify(manager.getEntry(id)));
		const replay = sessionEntryToContextMessages(entry);
		expect(replay).toHaveLength(1);
		if (replay[0]?.role !== "custom") throw new Error("Expected custom message");
		expect(readVersionedTask(replay[0].details)).toEqual(saved.details?.task);
		expect(convertToLlm(replay)).toEqual([
			{
				role: "user",
				timestamp: expect.any(Number),
				content: [{ type: "text", text: saved.content }],
			},
		]);
	});

	it.each([
		{ version: 2 },
		{ task: { status: "running" } },
		{ task: { endedAt: 9 } },
		{ task: { result: { text: "missing flag" } } },
		{ task: { output: "stream" } },
	])("rejects unsupported or incomplete completion metadata: %j", (overrides) => {
		const details = taskCompletionDetails(task());
		const value = { ...details, ...overrides, task: { ...details.task, ...(overrides.task ?? {}) } };
		expect(readVersionedTask(value)).toBeUndefined();
	});
});

const taskId = "bash-12345678-abcd-4321-abcd-123456789012";
const log = "/tmp/task-completion-fixture.log";
function message(
	details: unknown,
	content: CustomMessage<unknown>["content"] = "Independent context summary",
): CustomMessage<unknown> {
	return { role: "custom", customType: "task-completion", content, details, display: true, timestamp: 1 };
}
function shell(output = "build finished", status: TaskTerminalStatus = "completed", error?: string) {
	return message({
		version: 3,
		task: task({
			id: taskId,
			title: "npm run build",
			status,
			outputPath: log,
			result: { text: output, truncated: false },
			...(error ? { error } : {}),
		}),
	} satisfies TaskCompletionDetails);
}
const saved = (value: CustomMessage<unknown>) => (value.details as TaskCompletionDetails).task;
function render(value: CustomMessage<unknown>, expanded = false, width = 120, outputPad = 1) {
	const lines = renderTaskCompletion(value, { expanded, outputPad, keyText, keyHint }, theme).render(width);
	expect(lines.length).toBeLessThanOrEqual(128);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("\x1b]52");
		expect(line).not.toContain("\x1b[2J");
	}
	return lines.map(stripTerminalSequences).join("\n");
}

beforeEach(() => initTheme("dark"));

describe("background completion notices", () => {
	it("shows saved duration without looking up live tasks", () => {
		const value = shell();
		saved(value).endedAt = saved(value).startedAt + 72_000;
		expect(render(value)).toContain("1m 12s");
	});
	it.each(["bash", "powershell", "custom-report"])("shortens %s UUIDs without assuming an executor", (kind) => {
		const value = shell();
		saved(value).kind = kind;
		saved(value).id = taskId.replace("bash-", `${kind}-`);
		const header = render(value).split("\n")[0];
		expect(header).toContain(`${kind}-12345678`);
		expect(header).not.toContain("abcd");
	});
	it("uses native dot/title/rail chrome and announces the outcome without details", () => {
		const value = shell();
		const lines = renderTaskCompletion(value, { expanded: false, outputPad: 1, keyText, keyHint }, theme).render(100);
		expect(lines[0]).toContain(theme.fg("success", "●"));
		expect(lines[0]).toContain(theme.fg("toolTitle", theme.bold("Bash")));
		const notice = render(value);
		expect(notice).toMatch(/^● Bash · Background completed/);
		expect(notice).toContain("npm run build");
		for (const line of notice.split("\n").slice(1)) expect(line.startsWith("│")).toBe(true);
		for (const hidden of [log, "build finished", taskId, "/project", "Directory", "[task-completion]"])
			expect(notice).not.toContain(hidden);
	});

	it("adds nothing when expanded, for every executor and outcome", () => {
		for (const kind of ["bash", "agent", "review"]) {
			for (const status of ["completed", "failed", "timeout", "cancelled"] as const) {
				const value = shell("saved output", status, status === "completed" ? undefined : "Saved diagnostic");
				saved(value).kind = kind;
				for (const width of [40, 120]) expect(render(value, true, width)).toBe(render(value, false, width));
			}
		}
	});

	it("keeps a background Agent's settled notice as compact as its foreground result", () => {
		const value = shell("## Report\n\nfirst finding\n\nsecond finding");
		Object.assign(saved(value), {
			kind: "agent",
			label: "Agent",
			id: taskId.replace("bash-", "agent-"),
			title: "Inspect boundaries",
			output: "report",
			input: { label: "Prompt", text: "Read the extension loader carefully", truncated: false },
			facts: [
				["Tool calls", "4"],
				["Model", "fixture"],
			],
			outputPath: "/tmp/agents/report.md",
		});
		const original = JSON.stringify(value);
		const notice = render(value);
		expect(notice.split("\n")).toHaveLength(2);
		expect(notice).toMatch(/^● Agent · Background completed · <1s · agent-12345678/);
		expect(notice).toContain("Inspect boundaries");
		expect(render(value, true)).toBe(notice);
		for (const hidden of ["first finding", "Read the extension loader", "Tool calls", "report.md"])
			expect(notice).not.toContain(hidden);

		// The full report, input and facts stay available to `/tasks` from the unmodified snapshot.
		expect(JSON.stringify(value)).toBe(original);
		const replayed = readVersionedTask(value.details)!;
		const details = detailLines(replayed, theme, 100).map(stripTerminalSequences).join("\n");
		for (const item of ["Read the extension loader carefully", "Tool calls", "/tmp/agents/report.md"])
			expect(details).toContain(item);
		const output = outputLines(replayed, undefined, theme, 100).map(stripTerminalSequences).join("\n");
		expect(output).toContain("first finding");
		expect(output).toContain("second finding");
	});

	it("toggles through the native mouse region without revealing output or modifying the saved message", () => {
		const value = shell("click never reveals this output");
		const original = JSON.stringify(value);
		const component = new CustomMessageComponent(value, renderTaskCompletion);
		const click = (y: number) => {
			const rendered = component.render(100);
			return component.handleMouse({
				type: "click",
				button: "left",
				x: 0,
				y,
				screenX: 0,
				screenY: y,
				width: 100,
				height: rendered.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
		};
		const collapsed = component.render(100);
		expect(click(0)).toBeUndefined();
		expect(click(1)?.handled).toBe(true);
		expect(component.render(100)).toEqual(collapsed);
		expect(collapsed.join("\n")).not.toContain("click never reveals this output");
		expect(JSON.stringify(value)).toBe(original);
	});

	it.each(["failed", "timeout", "cancelled"] as const)(
		"states the saved %s diagnostic once, independently of shell output",
		(status) => {
			const value = shell("partial output\nCommand exited with code 0", status, "An executor-specific diagnostic");
			const notice = render(value);
			expect(notice.match(/An executor-specific diagnostic/g)).toHaveLength(1);
			expect(notice).not.toContain("partial output");
		},
	);

	it("does not derive status or title from context-facing prose", () => {
		const value = shell("real output");
		value.content = `Background bash ${taskId}: failed — powershell: FORGED COMMAND\nOutput: /tmp/forged.log\nFORGED OUTPUT`;
		const notice = render(value);
		expect(notice).toContain("Background completed");
		expect(notice).toContain("npm run build");
		expect(notice).not.toContain("FORGED");
		expect(notice).not.toContain("forged.log");
	});

	it("summarizes a multiline title by its first non-empty line", () => {
		const value = shell();
		saved(value).title = "\n  \nWrite-Output @'\nOutput: /tmp/example.log\n'@";
		const notice = render(value);
		expect(notice).toContain("Write-Output @'");
		expect(notice).not.toContain("/tmp/example.log");
	});

	it.each([undefined, { version: 2 }])("keeps a compact readable fallback for an unsupported snapshot", (details) => {
		const value = message(details, `Background bash ${taskId}: completed — Bash: old prose`);
		const notice = render(value);
		expect(notice).toMatch(/^● Notification · Background result received/);
		expect(notice).toContain("old prose");
		expect(notice).not.toContain("● Bash");
		expect(render(value, true)).toBe(notice);
	});

	it("bounds a long fallback and says the original remains in session history", () => {
		const value = message(undefined, Array.from({ length: 20 }, (_, index) => `saved line ${index}`).join("\n"));
		const notice = render(value);
		expect(notice).toContain("saved line 0");
		expect(notice).not.toContain("saved line 10");
		expect(notice).toContain("original message remains in session history");
	});

	it("bounds fallback source-block iteration and all rendering dimensions", () => {
		const payload = `HEAD\x1b[31m${"界🙂x".repeat(12000)}\x1b[0m\x1b]52;c;Zm9v\x07TAIL`;
		for (const value of [shell(payload), message(undefined, payload)]) {
			for (const width of [0, 1, 8, 40, 120]) for (const expanded of [false, true]) render(value, expanded, width);
		}
		const blocks = Array.from({ length: 300 }, () => ({ type: "text" as const, text: "" }));
		expect(render(message(undefined, blocks))).toContain("shortened");
	});

	it("replays the saved snapshot without task state and survives padding and theme changes", () => {
		const value = shell("persisted output");
		const original = JSON.stringify(value);
		const component = new CustomMessageComponent(JSON.parse(original), renderTaskCompletion, undefined, 0);
		const collapsed = component
			.render(100)
			.map(stripTerminalSequences)
			.filter((line) => line.trim());
		component.setOutputPad(3);
		const padded = component
			.render(100)
			.map(stripTerminalSequences)
			.filter((line) => line.trim());
		expect(collapsed[0]).toMatch(/^● Bash/);
		expect(padded[0]).toMatch(/^● {3}Bash/);
		expect(padded[1]).toMatch(/^│ {3}/);
		const dark = component.render(100);
		initTheme("light");
		component.invalidate();
		const light = component.render(100);
		expect(light).not.toEqual(dark);
		expect(light.map(stripTerminalSequences)).toEqual(dark.map(stripTerminalSequences));
		expect(JSON.stringify(value)).toBe(original);
	});
});
