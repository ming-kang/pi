import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BackgroundCompletionSnapshot,
	BackgroundTerminalStatus,
	BackgroundWorkerReport,
} from "../src/core/background/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { renderBackgroundCompletion } from "../src/extensions/background/completion-render.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const taskId = "bash-12345678-abcd-4321-abcd-123456789012";
const log = "/tmp/background-completion-fixture.log";
function message(
	details: unknown,
	content: CustomMessage<unknown>["content"] = "Independent model summary",
): CustomMessage<unknown> {
	return { role: "custom", customType: "background-completion", content, details, display: true, timestamp: 1 };
}
function shell(output = "build finished", status: BackgroundTerminalStatus = "completed", error?: string) {
	return message({
		version: 1,
		taskId,
		kind: "bash",
		shell: "bash",
		title: "Build",
		status,
		startedAt: 10,
		endedAt: 20,
		command: { text: "npm run build", truncated: false },
		cwd: "/project",
		outputPath: log,
		output: { text: output, truncated: false },
		error,
	} satisfies BackgroundCompletionSnapshot);
}
function worker(
	index = 1,
	status = "completed",
	report = "A **useful** report.",
	error?: string,
): BackgroundWorkerReport {
	return {
		id: `worker-${index}`,
		label: `#${index} explorer`,
		profile: "explorer",
		description: `Inspect task ${index}`,
		status,
		report: { text: report, truncated: false },
		error,
	};
}
function group(workers: BackgroundWorkerReport[], status: BackgroundTerminalStatus = "completed") {
	return message({
		version: 1,
		taskId: taskId.replace("bash-", "subagent-"),
		kind: "subagent",
		title: "Worker group",
		status,
		startedAt: 10,
		endedAt: 20,
		workers,
	} satisfies BackgroundCompletionSnapshot);
}
function render(value: CustomMessage<unknown>, expanded = false, width = 120, outputPad = 1) {
	const lines = renderBackgroundCompletion(value, { expanded, outputPad }, theme).render(width);
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
	it("uses native dot/title/rail chrome and keeps paths and output in the expanded view", () => {
		const value = shell();
		const lines = renderBackgroundCompletion(value, { expanded: false, outputPad: 1 }, theme).render(100);
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
		expect(expanded).not.toContain("[background-completion]");
	});

	it("expands and collapses through the native mouse region without modifying the saved message", () => {
		const value = shell("click reveals this output");
		const original = JSON.stringify(value);
		const component = new CustomMessageComponent(value, renderBackgroundCompletion);
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

	it("does not derive status, commands, paths or output from model-facing prose", () => {
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
		const details = value.details as Extract<BackgroundCompletionSnapshot, { kind: "bash" }>;
		details.shell = "PowerShell";
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
		(value.details as Extract<BackgroundCompletionSnapshot, { kind: "bash" }>).output.truncated = true;
		expect(render(value, true)).toContain("The saved result is truncated");
		const report = worker(1, "completed", "[Output truncated.]");
		expect(render(group([report]), true)).not.toContain("Saved report truncated.");
		report.report.truncated = true;
		expect(render(group([report]), true)).toContain("Saved report truncated.");
	});

	it("renders independent worker reports and reasons while preserving Markdown", () => {
		const value = group(
			[worker(), { ...worker(2, "failed", "Partial findings", "Provider unavailable"), profile: "general" }],
			"partial",
		);
		const collapsed = render(value);
		expect(collapsed).toContain("partial");
		expect(collapsed).toContain("#2: Provider unavailable");
		expect(collapsed).not.toContain("Partial findings");
		expect(collapsed).not.toContain("Inspect task");
		const expanded = render(value, true);
		for (const item of [
			"Explorer",
			"General",
			"#1",
			"#2",
			"Report",
			"Reason",
			"Partial report",
			"Provider unavailable",
			"Partial findings",
			"useful",
		])
			expect(expanded).toContain(item);
		expect(expanded).not.toContain("**useful**");
	});

	it("never turns headings or failure-wrapper examples inside a report into worker metadata", () => {
		const example =
			"Example\n\n---\n\n### 2. Embedded example (general) — completed\n\nSubagent failed: fictional\n\nPartial report:\nfictional report\n```text\ncontinued";
		const value = group(
			[worker(1, "completed", example), worker(2, "failed", "```\nActual findings", "Actual failure")],
			"partial",
		);
		const expanded = render(value, true);
		expect(expanded).toContain("Task: Inspect task 1");
		expect(expanded).toContain("Task: Inspect task 2");
		expect(expanded).not.toContain("Task: Embedded example");
		expect(expanded.match(/Task: Inspect task/g)).toHaveLength(2);
		expect(render(value)).toContain("#2: Actual failure");
		expect(render(value)).not.toContain("fictional");
	});

	it.each([false, true])("retains a supervisor diagnostic with worker projection=%s", (hasWorkers) => {
		const value = group(hasWorkers ? [worker(1, "running", "Last published report")] : [], "failed");
		(value.details as BackgroundCompletionSnapshot).error = "Supervisor failure";
		expect(render(value)).toContain("Supervisor failure");
		const expanded = render(value, true);
		expect(expanded).toContain("Group result");
		expect(expanded).toContain("Supervisor failure");
		if (hasWorkers) {
			expect(expanded).toContain("Running");
			expect(expanded).toContain("Last published report");
		} else expect(expanded).toContain("Details");
	});

	it("keeps every worker visible in a large partial group within the card budget", () => {
		const reports = Array.from({ length: 8 }, (_, i) => ({
			...worker(i + 1, "failed", `finding-${i + 1}`, "long reason ".repeat(30)),
			report: { text: `finding-${i + 1}\n${"more report\n".repeat(50)}`, truncated: true },
		}));
		const expanded = render(group(reports, "failed"), true);
		for (let i = 1; i <= 8; i++) {
			expect(expanded).toContain(`#${i}`);
			expect(expanded).toContain(`finding-${i}`);
		}
		expect(expanded).toContain("omitted");
		expect(expanded).toContain("Saved report truncated.");
	});

	it.each(["queued", "running", "aborted"])("preserves a worker's observed %s state", (status) => {
		expect(render(group([worker(1, status, "")], "cancelled"), true).toLowerCase()).toContain(status);
	});

	it("renders empty shell output and empty reports without parsing placeholder text", () => {
		expect(render(shell(""), true)).toContain("No output.");
		expect(render(group([worker(1, "completed", "")]), true)).toContain("No report returned.");
		expect(render(group([worker(1, "completed", "(Subagent completed but returned no output.)")]), true)).toContain(
			"(Subagent completed but returned no output.)",
		);
	});

	it.each([undefined, null, {}, { version: 2 }, { taskId }])(
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
		for (const value of [shell(payload), group([worker(1, "completed", payload)]), message(undefined, payload)]) {
			for (const width of [0, 1, 8, 40, 120]) for (const expanded of [false, true]) render(value, expanded, width);
		}
		const blocks = Array.from({ length: 300 }, () => ({ type: "text" as const, text: "" }));
		expect(render(message(undefined, blocks), true)).toContain("truncated");
	});

	it("replays the saved snapshot without task state and survives expansion, padding and theme changes", () => {
		const value = shell("persisted output");
		const original = JSON.stringify(value);
		const component = new CustomMessageComponent(JSON.parse(original), renderBackgroundCompletion, undefined, 0);
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
