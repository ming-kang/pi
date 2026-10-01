import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { isTaskTerminal } from "../../src/core/tasks/types.ts";
import { TasksMenu } from "../../src/modes/interactive/tasks/manager.ts";
import type { TasksPanelState } from "../../src/modes/interactive/tasks/model.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { startTasksScenario } from "../fixtures/tasks-scenario.ts";
import { createHarness } from "./harness.ts";

it("inspects concurrent shell/report work through detach, stop, completion, reload and branch return", async () => {
	initTheme("dark");
	const harness = await createHarness({ settings: { compaction: { enabled: false } } });
	const { session, sessionManager } = harness;
	harness.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("Task result received.")));
	await session.bindExtensions({ tasksEnabled: true });
	const root = sessionManager.appendMessage({ role: "user", content: "Task scenario root", timestamp: Date.now() });
	const scenario = await startTasksScenario(session.tasks, harness.tempDir);
	const state: TasksPanelState = { tab: "output", selectedId: scenario.foregroundId };
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender: () => {} };
	let menu: TasksMenu | undefined;
	const frames: Record<string, string> = {};
	const open = () => {
		menu = new TasksMenu({
			host: session.tasks,
			tui,
			theme,
			keybindings: new KeybindingsManager(),
			state,
			onClose: () => {},
			pollIntervalMs: 25,
		});
	};
	const frame = () => menu!.render(tui.terminal.columns).map(stripTerminalSequences).join("\n");
	try {
		open();
		await vi.waitFor(() => expect(frame()).toContain("foreground-build output 90"));
		frames.running = frame();
		menu!.handleInput("/");
		menu!.handleInput(scenario.cancelId);
		menu!.handleInput("\r");
		menu!.handleInput("k");
		menu!.handleInput("\r");
		await vi.waitFor(() => expect(session.tasks.get(scenario.cancelId).status).toBe("cancelled"));
		menu!.handleInput("/");
		menu!.handleInput("\x1b");
		menu!.handleInput("/");
		menu!.handleInput(scenario.foregroundId);
		menu!.handleInput("\r");
		menu!.handleInput("b");
		expect(session.tasks.get(scenario.foregroundId).mode).toBe("background");
		menu!.handleInput("\t");
		menu!.handleInput("\x1b[H");
		expect(frame()).toContain("foreground-build output 1");
		tui.terminal.columns = 72;
		tui.terminal.rows = 22;
		frames.browsing = frame();
		await scenario.finish();
		await vi.waitFor(() => expect(isTaskTerminal(session.tasks.get(scenario.foregroundId).status)).toBe(true));
		expect(frame()).not.toContain("foreground-build final output");
		menu!.handleInput("f");
		await vi.waitFor(() => expect(frame()).toContain("foreground-build final output"));
		expect(state.selectedId).toBe(scenario.foregroundId);
		frames.finished = frame();
		await vi.waitFor(() => expect(session.tasks.list().every((task) => isTaskTerminal(task.status))).toBe(true));
		await vi.waitFor(() =>
			expect(
				sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "task-completion"),
			).toHaveLength(4),
		);
		await session.waitForIdle();
		const notices = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "task-completion");
		expect(session.tasks.get(scenario.failureId)).toMatchObject({ status: "failed", exitCode: 42 });
		expect(session.tasks.get(scenario.reportId).status).toBe("partial");
		menu!.dispose();
		await session.reload();
		open();
		menu!.handleInput("\t");
		await vi.waitFor(() => expect(frame()).toContain("foreground-build final output"));
		frames.reloaded = frame();
		expect(
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "task-completion"),
		).toEqual(notices);
		const leaf = sessionManager.getLeafId()!;
		menu!.dispose();
		await session.navigateTree(root);
		await session.reload();
		expect(session.tasks.list()).toEqual([]);
		await session.navigateTree(leaf);
		open();
		menu!.handleInput("\t");
		await vi.waitFor(() => expect(frame()).toContain("foreground-build final output"));
		frames.returned = frame();
		expect(scenario.errors).toEqual([]);
		const artifacts = join(process.cwd(), ".artifacts", "tasks-redesign", "e2e");
		mkdirSync(artifacts, { recursive: true });
		writeFileSync(join(artifacts, "frames.json"), JSON.stringify(frames, null, 2));
		writeFileSync(
			join(artifacts, "results.json"),
			JSON.stringify(
				session.tasks.list().map((task) => ({ kind: task.kind, status: task.status, exitCode: task.exitCode })),
				null,
				2,
			),
		);
	} finally {
		menu?.dispose();
		await scenario.cleanup();
		await session.tasks.shutdown();
		harness.cleanup();
	}
});
