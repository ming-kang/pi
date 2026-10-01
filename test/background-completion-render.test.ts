import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import type { TaskCompletionSnapshot, TaskTerminalStatus } from "../src/core/tasks/types.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { renderTaskCompletion } from "../src/modes/interactive/tasks/completion-render.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

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

	it.each([undefined, null, {}, { version: 1 }, { version: 2 }, { taskId }])(
		"uses bounded plain details for an unsupported snapshot",
		(details) => {
			const value = message(details, `Background bash ${taskId}: completed — Bash: old prose`);
			const expanded = render(value, true);
			expect(expanded).toContain("Notification");
			expect(expanded).toContain("Details");
			expect(expanded).not.toContain("● Bash");
			expect(expanded).not.toContain("Command\n");
		},
	);

	it("does not invoke snapshot accessors or serializers", () => {
		const getter = vi.fn(() => 1);
		const serialize = vi.fn();
		const details = Object.defineProperty({ toJSON: serialize }, "version", { get: getter });
		expect(render(message(details, "fallback"), true)).toContain("fallback");
		expect(getter).not.toHaveBeenCalled();
		expect(serialize).not.toHaveBeenCalled();
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
