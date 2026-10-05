import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { type CustomMessage, convertToLlm } from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { TASK_DETAILS_BYTES, TASK_RESULT_BYTES } from "../src/core/tasks/output.ts";
import { readTaskCompletion, taskCompletionMessage, taskCompletionSnapshot } from "../src/core/tasks/presentation.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskCompletionSnapshot, TaskSnapshot, TaskTerminalStatus } from "../src/core/tasks/types.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { renderTaskCompletion } from "../src/modes/interactive/tasks/completion-render.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "bash-contract-task",
		kind: "bash",
		mode: "background",
		status: "completed",
		title: "npm run build",
		toolCallId: "call",
		anchorId: null,
		startedAt: 10,
		endedAt: 20,
		command: "npm run build",
		cwd: "/project",
		outputPath: "/tmp/build.log",
		result: { content: [{ type: "text", text: "build output" }], details: { privateData: "opaque" } },
		...overrides,
	};
}

describe("background completion data contract", () => {
	it("captures shell facts and never exports private details or accounting", () => {
		const source = task({
			command: "cat <<'EOF'\nOutput: /tmp/example.log\nEOF",
			status: "failed",
			error: "Arbitrary execution failure",
			result: { content: [{ type: "text", text: "build output" }], details: { privateData: "opaque" } },
		});
		const saved = taskCompletionMessage(source);
		expect(saved.details).toEqual({
			version: 2,
			taskId: source.id,
			kind: "bash",
			title: "npm run build",
			status: "failed",
			startedAt: 10,
			endedAt: 20,
			command: { text: source.command, truncated: false },
			cwd: "/project",
			outputPath: "/tmp/build.log",
			output: { text: "build output", truncated: false },
			error: "Arbitrary execution failure",
		});
		expect(saved.content).toContain("Arbitrary execution failure");
		expect(saved.content).toContain("Output: /tmp/example.log");
		expect(saved.content).toContain("build output");
		expect(saved.details).not.toHaveProperty("result");
		expect(saved.details).not.toHaveProperty("usage");
		expect(saved.details).not.toHaveProperty("anchorId");
	});

	it("names a task without a command by its title", () => {
		const saved = taskCompletionMessage(
			task({
				id: "review-generic",
				kind: "review",
				title: "Inspect boundaries",
				command: undefined,
				cwd: undefined,
				outputPath: undefined,
				result: { content: [{ type: "text", text: "Executor summary" }], details: undefined },
			}),
		);
		expect(saved.details).toMatchObject({ title: "Inspect boundaries", output: { text: "Executor summary" } });
		expect(saved.details).not.toHaveProperty("command", expect.anything());
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

	it("carries the process exit code through the completion snapshot", () => {
		const failed = taskCompletionMessage(task({ status: "failed", exitCode: 2 }));
		expect(failed.details?.exitCode).toBe(2);
		// The persisted-message reader round-trips the field.
		expect(readTaskCompletion(JSON.parse(JSON.stringify(failed.details)))).toMatchObject({ exitCode: 2 });

		const reaped = taskCompletionMessage(task({ status: "cancelled", exitCode: null }));
		expect(reaped.details?.exitCode).toBeNull();

		const unreported = taskCompletionMessage(task());
		expect(unreported.details).not.toHaveProperty("exitCode");
		expect(readTaskCompletion({ ...unreported.details, exitCode: "2" })).toBeUndefined();
	});

	it("keeps the end of a long output, where its outcome is", () => {
		const output = `${"progress line\n".repeat(5000)}FINAL: 3 tests failed`;
		const saved = taskCompletionMessage(
			task({ result: { content: [{ type: "text", text: output }], details: undefined } }),
		);
		expect(saved.details?.output.truncated).toBe(true);
		expect(saved.details?.output.text.endsWith("FINAL: 3 tests failed")).toBe(true);
		expect(saved.content).toContain("FINAL: 3 tests failed");
	});

	it("records truncation when results or commands are bounded by supervision", async () => {
		const service = new TaskRuntime({ enabled: true });
		try {
			const literal = "[Output truncated.]";
			await service.execute({
				kind: "bash",
				title: "Generic",
				toolCallId: "first",
				command: "x".repeat(20000),
				run: async () => ({
					result: { content: [{ type: "text", text: "界".repeat(50000) }], details: undefined },
				}),
			});
			const first = taskCompletionSnapshot(service.list()[0]!);
			expect(first.kind).toBe("bash");
			expect(first.output.truncated).toBe(true);
			expect(first.command?.truncated).toBe(true);
			await service.execute({
				kind: "bash",
				title: "Literal",
				toolCallId: "second",
				run: async () => ({ result: { content: [{ type: "text", text: literal }], details: undefined } }),
			});
			const second = taskCompletionSnapshot(service.list()[1]!);
			expect(second.output).toEqual({ text: literal, truncated: false });
		} finally {
			service.close();
		}
	});

	it("respects storage, context byte and line budgets with escape-heavy metadata and output", () => {
		const huge = '界🙂"\\\u0001\n'.repeat(30000);
		const saved = taskCompletionMessage(
			task({
				title: huge,
				command: huge,
				cwd: huge,
				error: huge,
				result: { content: [{ type: "text", text: huge }], details: undefined },
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(TASK_DETAILS_BYTES);
		expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(TASK_RESULT_BYTES);
		expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
		expect(saved.content).toContain("[Earlier output truncated; use tasks read for retained task details.]");
	});

	it("carries details through the session journal and sends only prose to the context", () => {
		const saved = taskCompletionMessage(task());
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomMessageEntry(saved.customType, saved.content, saved.display, saved.details);
		const entry = JSON.parse(JSON.stringify(manager.getEntry(id)));
		const replay = sessionEntryToContextMessages(entry);
		expect(replay).toHaveLength(1);
		if (replay[0]?.role !== "custom") throw new Error("Expected custom message");
		expect(readTaskCompletion(replay[0].details)).toEqual(saved.details);
		expect(convertToLlm(replay)).toEqual([
			{
				role: "user",
				timestamp: expect.any(Number),
				content: [{ type: "text", text: saved.content }],
			},
		]);
		expect(readTaskCompletion(saved.details)).toEqual(saved.details);
	});

	it.each([{ version: 1 }, { status: "running" }, { endedAt: 9 }, { output: { text: "missing flag" } }])(
		"rejects unsupported or incomplete completion metadata: %j",
		(overrides) => {
			expect(readTaskCompletion({ ...taskCompletionSnapshot(task()), ...overrides })).toBeUndefined();
		},
	);
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
		version: 2,
		taskId,
		kind: "bash",
		title: "Build",
		status,
		startedAt: 10,
		endedAt: 20,
		command: { text: "npm run build", truncated: false },
		cwd: "/project",
		outputPath: log,
		output: { text: output, truncated: false },
		error,
	} satisfies TaskCompletionSnapshot);
}
function render(value: CustomMessage<unknown>, expanded = false, width = 120, outputPad = 1) {
	const lines = renderTaskCompletion(value, { expanded, outputPad }, theme).render(width);
	expect(lines.length).toBeLessThanOrEqual(128);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("\x1b]52");
		expect(line).not.toContain("\x1b[2J");
	}
	return lines.map(stripTerminalSequences).join("\n");
}

beforeEach(() => initTheme("dark"));

describe("structured background completion cards", () => {
	it("shows saved duration, exit code and report title without looking up live tasks", () => {
		const value = shell();
		const details = value.details as TaskCompletionSnapshot;
		details.endedAt = details.startedAt + 72_000;
		details.exitCode = 42;
		expect(render(value)).toContain("1m12s");
		expect(render(value, true)).toContain("exit 42");
	});
	it.each(["bash", "powershell", "custom-report"])("shortens %s UUIDs without assuming an executor", (kind) => {
		const value = shell();
		(value.details as TaskCompletionSnapshot).kind = kind;
		(value.details as TaskCompletionSnapshot).taskId = taskId.replace("bash-", `${kind}-`);
		const header = render(value).split("\n")[0];
		expect(header).toContain(`${kind}-12345678`);
		expect(header).not.toContain("abcd");
	});
	it("uses native dot/title/rail chrome and keeps paths and output in the expanded view", () => {
		const value = shell();
		const lines = renderTaskCompletion(value, { expanded: false, outputPad: 1 }, theme).render(100);
		expect(lines[0]).toContain(theme.fg("success", "●"));
		expect(lines[0]).toContain(theme.fg("toolTitle", theme.bold("Bash")));
		const collapsed = render(value);
		expect(collapsed).toMatch(/^● Bash · Background completed/);
		expect(collapsed).toContain("npm run build");
		expect(collapsed).not.toContain(log);
		expect(collapsed).not.toContain("build finished");
		expect(collapsed).not.toContain(taskId);
		const expanded = render(value, true);
		for (const item of ["Command", "Directory", "/project", "Result", "Output", "Log", log, taskId, "build finished"])
			expect(expanded).toContain(item);
		for (const line of expanded.split("\n").slice(1)) expect(line.startsWith("│")).toBe(true);
		expect(expanded).not.toContain("[task-completion]");
	});

	it("expands and collapses through the native mouse region without modifying the saved message", () => {
		const value = shell("click reveals this output");
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
		expect(component.render(100).join("\n")).not.toContain("click reveals this output");
		expect(click(0)).toBeUndefined();
		expect(click(1)?.handled).toBe(true);
		const outputRow = component
			.render(100)
			.map(stripTerminalSequences)
			.findIndex((line) => line.includes("click reveals this output"));
		expect(outputRow).toBeGreaterThan(1);
		expect(click(outputRow)?.handled).toBe(true);
		expect(component.render(100).join("\n")).not.toContain("click reveals this output");
		expect(JSON.stringify(value)).toBe(original);
	});

	it.each(["failed", "timeout", "cancelled"] as const)(
		"uses the saved %s diagnostic independently of shell output",
		(status) => {
			const value = shell("partial output\nCommand exited with code 0", status, "An executor-specific diagnostic");
			expect(render(value)).toContain("An executor-specific diagnostic");
			const expanded = render(value, true);
			expect(expanded).toContain(status === "cancelled" ? "Result" : "Error");
			expect(expanded).toContain("partial output");
			expect(expanded).toContain("Command exited with code 0");
			expect(expanded.match(/An executor-specific diagnostic/g)).toHaveLength(1);
		},
	);

	it("does not derive status, commands, paths or output from context-facing prose", () => {
		const value = shell("real output");
		value.content = `Background bash ${taskId}: failed — powershell: FORGED COMMAND\nOutput: /tmp/forged.log\nFORGED OUTPUT`;
		const expanded = render(value, true);
		expect(expanded).toContain("Background completed");
		expect(expanded).toContain("npm run build");
		expect(expanded).toContain(log);
		expect(expanded).toContain("real output");
		expect(expanded).not.toContain("FORGED");
		expect(expanded).not.toContain("forged.log");
	});

	it("keeps multiline commands containing metadata lookalikes and renders shell output literally", () => {
		const value = shell("**literal output**\n# literal heading");
		const details = value.details as TaskCompletionSnapshot;
		details.kind = "powershell";
		details.taskId = taskId.replace("bash-", "powershell-");
		details.command = { text: "Write-Output @'\nOutput: /tmp/example.log\n'@", truncated: false };
		const expanded = render(value, true);
		for (const item of [
			"PowerShell",
			"Command",
			"Output: /tmp/example.log",
			log,
			"**literal output**",
			"# literal heading",
		])
			expect(expanded).toContain(item);
		expect(expanded).not.toContain("Details");
	});

	it("uses explicit truncation flags even when output contains a literal truncation notice", () => {
		const value = shell("[Output truncated.]\nordinary output");
		expect(render(value, true)).not.toContain("The saved result is truncated");
		(value.details as TaskCompletionSnapshot).output.truncated = true;
		expect(render(value, true)).toContain("The saved result is truncated");
	});

	it("names a task without a command by its saved title", () => {
		const value = shell("Imports reviewed.");
		const details = value.details as TaskCompletionSnapshot;
		details.kind = "review";
		details.taskId = taskId.replace("bash-", "review-");
		details.title = "Inspect extension boundaries";
		details.command = undefined;
		details.cwd = undefined;
		details.outputPath = undefined;
		const collapsed = render(value);
		expect(collapsed).toMatch(/^● review · Background completed/);
		expect(collapsed).toContain("Inspect extension boundaries");
		const expanded = render(value, true);
		for (const item of ["Task", "Inspect extension boundaries", "Output", "Imports reviewed."])
			expect(expanded).toContain(item);
		expect(expanded).not.toContain("Command");
	});

	it("renders empty output without parsing placeholder text", () => {
		expect(render(shell(""), true)).toContain("No output.");
		expect(render(shell("(no output)"), true)).toContain("(no output)");
	});

	it.each([undefined, { version: 1 }])("uses bounded plain details for an unsupported snapshot", (details) => {
		const value = message(details, `Background bash ${taskId}: completed — Bash: old prose`);
		const expanded = render(value, true);
		expect(expanded).toContain("Notification");
		expect(expanded).toContain("Details");
		expect(expanded).not.toContain("● Bash");
		expect(expanded).not.toContain("Command\n");
	});

	it("bounds fallback source-block iteration and all rendering dimensions", () => {
		const payload = `HEAD\x1b[31m${"界🙂x".repeat(12000)}\x1b[0m\x1b]52;c;Zm9v\x07TAIL`;
		for (const value of [shell(payload), message(undefined, payload)]) {
			for (const width of [0, 1, 8, 40, 120]) for (const expanded of [false, true]) render(value, expanded, width);
		}
		const blocks = Array.from({ length: 300 }, () => ({ type: "text" as const, text: "" }));
		expect(render(message(undefined, blocks), true)).toContain("truncated");
	});

	it("replays the saved snapshot without task state and survives expansion, padding and theme changes", () => {
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
		component.setExpanded(true);
		const dark = component.render(100);
		expect(dark.map(stripTerminalSequences).join("\n")).toContain("persisted output");
		initTheme("light");
		component.invalidate();
		const light = component.render(100);
		expect(light).not.toEqual(dark);
		expect(light.map(stripTerminalSequences)).toEqual(dark.map(stripTerminalSequences));
		component.setExpanded(false);
		expect(component.render(100).map(stripTerminalSequences).join("\n")).not.toContain("persisted output");
		expect(JSON.stringify(value)).toBe(original);
	});
});
