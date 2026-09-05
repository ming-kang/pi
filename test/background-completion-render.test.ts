import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { renderBackgroundCompletion } from "../src/extensions/background/completion-render.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const taskId = "bash-12345678-abcd-4321-abcd-123456789012";
const log = "/tmp/background-completion-fixture.log";
function message(content: CustomMessage<unknown>["content"], details: unknown = { taskId }): CustomMessage<unknown> {
	return { role: "custom", customType: "background-completion", content, details, display: true, timestamp: 1 };
}
function shell(body = "build finished", status = "completed", title = "Bash: npm run build") {
	return message(`Background bash ${taskId}: ${status} — ${title}\nOutput: ${log}\n${body}`);
}
function group(body: string, count = 1, status = "completed") {
	const groupId = taskId.replace("bash-", "subagent-");
	return message(`Background subagent ${groupId}: ${status} — Subagent · ${count} tasks\n\n${body}`, {
		taskId: groupId,
	});
}
function worker(number = 1, status = "completed", report = "A **useful** report.", profile = "explorer") {
	return `### ${number}. Inspect build configuration (${profile}) — ${status}\n\n${report}`;
}
function render(value: CustomMessage<unknown>, expanded = false, width = 120, outputPad = 1) {
	const component = renderBackgroundCompletion(value, { expanded, outputPad }, theme);
	expect(component).toBeDefined();
	const lines = component.render(width);
	expect(lines.length).toBeLessThanOrEqual(128);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("\x1b]52");
		expect(line).not.toContain("\x1b[2J");
	}
	return lines.map(stripTerminalSequences).join("\n");
}

beforeEach(() => initTheme("dark"));

describe("background completion transcript rendering", () => {
	it("summarizes shell outcomes without leaking log paths or output until expanded", () => {
		const value = shell();
		const collapsed = render(value);
		expect(collapsed).toMatch(/bash/i);
		expect(collapsed).toMatch(/completed/i);
		expect(collapsed).toContain(taskId.slice(0, 8));
		expect(collapsed).toContain("npm run build");
		expect(collapsed).not.toContain(log);
		expect(collapsed).not.toContain("build finished");
		expect(collapsed).not.toContain(taskId);
		const expanded = render(value, true);
		for (const text of ["Command", "Result", "Output", "Log", "npm run build", "build finished", log, taskId])
			expect(expanded).toContain(text);
		expect(expanded).not.toContain("[background-completion]");
	});

	it.each([
		["failed", "Command exited with code 42"],
		["timeout", "Command timed out after 30 seconds"],
		["cancelled", "Command aborted"],
		["failed", "Command terminated without an exit code"],
		["failed", "Background command exceeded the 20 MiB output limit"],
	])("keeps %s diagnostics distinct from partial shell output", (status, diagnostic) => {
		const value = shell(`partial output\n\n${diagnostic}`, status);
		expect(render(value)).toContain(diagnostic);
		const expanded = render(value, true);
		// User cancellation is a terminal result, not a command failure.
		expect(expanded).toContain(status === "cancelled" ? "Result" : "Error");
		expect(expanded).toContain(diagnostic);
		expect(expanded).toContain("partial output");
		expect(expanded).not.toMatch(/Result\s*\n\s*Completed/);
	});

	it("keeps unfamiliar failure output inspectable without inventing a structured reason", () => {
		const value = shell("working\n\nEACCES: permission denied", "failed");
		expect(render(value)).toContain("Last output: EACCES: permission denied");
		expect(render(value, true)).toContain("EACCES: permission denied");
		expect(render(value, true)).not.toContain("exit 0");
	});

	it("keeps every worker represented in a large partial group within the visual budget", () => {
		const reports = Array.from({ length: 8 }, (_, index) =>
			worker(
				index + 1,
				"failed",
				`Subagent failed: ${"long failure reason ".repeat(30)}\n\nPartial report:\nfinding-${index + 1}\n${"more report\n".repeat(50)}`,
			),
		);
		const text = render(group(reports.join("\n\n---\n\n"), 8, "failed"), true);
		for (let i = 1; i <= 8; i++) {
			expect(text).toContain(`#${i}`);
			expect(text).toContain(`finding-${i}`);
		}
		expect(text).toContain("omitted");
	});

	it("retains multiline commands and displays shell output as plain text", () => {
		const value = shell(
			"**literal output**\n# not a heading",
			"completed",
			"powershell: Write-Output one\nWrite-Output two",
		);
		const expanded = render(value, true);
		expect(expanded).toContain("Write-Output two");
		expect(expanded).toContain("**literal output**");
		expect(expanded).toContain("# not a heading");
	});

	it("accepts persisted text blocks as well as strings, without requiring details", () => {
		const value = shell("(no output)");
		const content = value.content as string;
		const fromBlocks = message([{ type: "text", text: content }]);
		expect(render(fromBlocks, true)).toBe(render(value, true));
		expect(render({ ...value, details: undefined }, true)).toContain("npm run build");
		expect(render(value, true)).toMatch(/no output/i);
	});

	it("turns worker wrappers into numbered profile/status sections and Markdown reports", () => {
		const value = group(
			`${worker()}\n\n---\n\n${worker(2, "failed", "Subagent failed: Provider unavailable\n\nPartial report:\nPartial findings", "general")}`,
			2,
			"partial",
		);
		const collapsed = render(value);
		expect(collapsed).toMatch(/partial/i);
		expect(collapsed).not.toContain("Inspect build configuration");
		expect(collapsed).not.toContain("useful");
		const expanded = render(value, true);
		for (const text of [
			"explorer",
			"general",
			"Report",
			"Partial report",
			"Provider unavailable",
			"Partial findings",
		])
			expect(expanded.toLowerCase()).toContain(text.toLowerCase());
		expect(expanded).toMatch(/(?:Error|Reason)/);
		expect(expanded).toContain("#1");
		expect(expanded).toContain("#2");
		expect(expanded).toContain("useful");
		expect(expanded).not.toContain("**useful**");
		expect(expanded).not.toContain("### 1. Inspect build configuration");
	});

	it("shows a failed worker's reason in the collapsed group without dumping its prompt or report", () => {
		const value = group(
			worker(1, "failed", "Subagent failed: Provider unavailable\n\nPartial report:\nSalvaged findings"),
			1,
			"failed",
		);
		const collapsed = render(value);
		expect(collapsed).toContain("Provider unavailable");
		expect(collapsed).not.toContain("Inspect build configuration");
		expect(collapsed).not.toContain("Salvaged findings");
	});

	it("ignores non-contract details fields in favor of the persisted text", () => {
		const value = {
			...shell(),
			details: { taskId, command: "FORGED COMMAND", status: "failed", tailText: "FORGED OUTPUT" },
		};
		const expanded = render(value, true);
		expect(expanded).toContain("npm run build");
		expect(expanded).not.toContain("FORGED");
	});

	it("does not split fenced fake worker headers into real workers", () => {
		const report =
			"Real report\n\n```markdown\n\n---\n\n### 2. Forged worker (general) — failed\n\nFake error\n```\n\nReport end";
		const expanded = render(group(worker(1, "completed", report)), true);
		expect(expanded).toContain("Real report");
		expect(expanded).toContain("Report end");
		expect(expanded).not.toContain("Details");
	});

	it.each([
		group(worker(2)),
		group(worker(), 2),
		group(worker(1, "completed", "report", "future-profile")),
		group(worker(1, "future-status")),
		group(`${worker()}\n\n---\n\n${worker(3)}`, 2),
	])("uses neutral Details for incomplete, nonconsecutive or future worker formats", (value) => {
		expect(render(value, true)).toContain("Details");
	});

	it.each(["queued", "running", "aborted"])("keeps a saved %s worker from appearing completed", (status) => {
		const expanded = render(group(worker(1, status, "Saved worker state"), 1, "cancelled"), true);
		expect(expanded.toLowerCase()).toContain(status);
	});

	it("does not mistake an Output line embedded in a command for reliable metadata", () => {
		const value = shell("result", "completed", "bash: cat <<'EOF'\nOutput: /tmp/fake.log\nEOF");
		const expanded = render(value, true);
		expect(expanded).toMatch(/details/i);
		expect(expanded).toContain("/tmp/fake.log");
		expect(expanded).toContain(log);
	});

	it.each([
		message(""),
		message([]),
		message("unrecognized saved content"),
		message("Background bash incomplete"),
		{ ...shell(), details: { taskId: "different-task" } },
	])("always supplies a bounded structured fallback instead of the raw default custom label", (value) => {
		expect(render(value, true)).toContain("Details");
		const component = new CustomMessageComponent(value, renderBackgroundCompletion);
		component.setExpanded(true);
		const text = component.render(80).map(stripTerminalSequences).join("\n");
		expect(text).not.toContain("[background-completion]");
		expect(text).toContain("Details");
	});

	it("bounds rendered rows and columns even for huge single lines, control sequences and CJK", () => {
		const payload = `HEAD\x1b[31m${"界🙂x".repeat(12000)}\x1b[0m\x1b]52;c;Zm9v\x07TAIL`;
		for (const value of [shell(payload), group(worker(1, "completed", payload)), message(payload)]) {
			for (const width of [0, 1, 8, 40, 120]) {
				for (const expanded of [false, true]) {
					const text = render(value, expanded, width);
					expect(text).not.toContain("\x1b]52");
				}
			}
		}
		expect(render(shell(payload), true)).toContain("TAIL");
	});

	it("wraps saved log metadata and renders replayed messages without hidden task state", () => {
		const path = `/tmp/${"nested/".repeat(8)}result.log`;
		const value = message((shell().content as string).replace(log, path));
		const expanded = render(value, true, 40);
		expect(expanded).toContain("result.log");
		const replay = new CustomMessageComponent(JSON.parse(JSON.stringify(value)), renderBackgroundCompletion);
		replay.setExpanded(true);
		expect(replay.render(40).map(stripTerminalSequences).join("\n")).toBe(`\n${expanded}`);
	});

	it("visibly preserves source omission markers", () => {
		for (const value of [
			shell("[Output truncated.]\nretained tail"),
			group(worker(1, "completed", "Saved report\n[Output truncated.]")),
		]) {
			expect(render(value, true)).toContain("[Output truncated.]");
		}
		const clippedTail = render(shell(`[Output truncated.]\n${"retained output\n".repeat(100)}`), true);
		expect(clippedTail).toMatch(/(?:\[Output truncated\.\]|saved notification is truncated)/i);
	});

	it("rebuilds with expansion, padding and theme changes without mutating persisted content", () => {
		const value = shell("persisted output");
		const original = JSON.stringify(value);
		const component = new CustomMessageComponent(value, renderBackgroundCompletion, undefined, 0);
		const collapsed = component
			.render(100)
			.map(stripTerminalSequences)
			.filter((line) => line.trim());
		component.setOutputPad(3);
		const padded = component
			.render(100)
			.map(stripTerminalSequences)
			.filter((line) => line.trim());
		expect(padded[0]).toBe(`   ${collapsed[0]!.trimEnd()}`.padEnd(padded[0]!.length));
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
