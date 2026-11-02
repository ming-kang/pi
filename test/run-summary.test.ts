import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { formatRunSummary } from "../src/extensions/run-summary/format.ts";
import runSummary from "../src/extensions/run-summary/index.ts";
import { RUN_SUMMARY_ENTRY_TYPE, readRunSummaryRecord } from "../src/extensions/run-summary/record.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

async function tuiHarness(tools: AgentTool[] = []): Promise<Harness> {
	const harness = await createHarness({ tools, extensionFactories: [runSummary] });
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui" });
	return harness;
}

function summaries(harness: Harness): SessionEntry[] {
	return harness.sessionManager.getBranch().filter((entry) => readRunSummaryRecord(entry));
}

/** The transcript lines the interactive host renders for a summary entry. */
function renderSummary(harness: Harness, entry: SessionEntry | undefined, outputPad = 1): string[] {
	initTheme("dark");
	const renderer = harness.session.extensionRunner.getEntryRenderer(RUN_SUMMARY_ENTRY_TYPE);
	if (!renderer || entry?.type !== "custom") throw new Error("expected a rendered run summary entry");
	return new CustomEntryComponent(entry, renderer, outputPad).render(100).map((line) => stripAnsi(line).trimEnd());
}

describe("run summary formatting", () => {
	it("uses the Tasks duration style and a local completion timestamp", () => {
		const startedAt = new Date(2026, 9, 28, 13, 12, 22).getTime();
		const finishedAt = new Date(2026, 9, 28, 13, 14, 14).getTime();
		expect(formatRunSummary(startedAt, finishedAt)).toBe("Worked for 1m 52s · Done 2026/10/28 13:14");
		expect(formatRunSummary(startedAt, finishedAt, "stopped")).toBe("Worked for 1m 52s · Stopped 2026/10/28 13:14");
	});
});

describe("run summary lifecycle", () => {
	it("does not settle before steering and records one summary after the continuous run", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to steer",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await tuiHarness([waitTool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished after steering"),
		]);

		const prompting = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("adjust the current work");
		expect(summaries(harness)).toHaveLength(0);

		releaseTool();
		await prompting;

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(summaries(harness)).toEqual([harness.sessionManager.getLeafEntry()]);
		const line = renderSummary(harness, harness.sessionManager.getLeafEntry()).join("\n");
		expect(line).toMatch(/Worked for .+ · Done \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
		expect(line).not.toContain("TPS");
	});

	it("closes an interrupted run with Stopped before the next prompt", async () => {
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for cancellation",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				if (!signal) throw new Error("expected an abort signal");
				markToolStarted();
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "cancelled" }], details: {} };
			},
		};
		const harness = await tuiHarness([waitTool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const prompting = harness.session.prompt("start");
		await toolStarted;
		harness.session.abort();
		await prompting;

		harness.appendResponses([fauxAssistantMessage("next response")]);
		await harness.session.prompt("next prompt");
		const lines = summaries(harness).map((entry) => renderSummary(harness, entry).join("\n"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/Worked for .+ · Stopped \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
		expect(lines[1]).toMatch(/Worked for .+ · Done \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
	});

	it("writes no duplicate record on reload or branch navigation", async () => {
		const harness = await tuiHarness();
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("start");
		const record = readRunSummaryRecord(harness.sessionManager.getLeafEntry()!);
		if (!record) throw new Error("missing run record");
		const recordId = harness.sessionManager.getLeafId()!;

		await harness.session.reload();
		await harness.session.navigateTree(record.afterEntryId, { summarize: false });
		await harness.session.navigateTree(recordId, { summarize: false });
		expect(summaries(harness).map((entry) => entry.id)).toEqual([recordId]);
	});

	it("renders a dim line inset by the outputPad setting", async () => {
		const harness = await tuiHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");

		const [spacer, line] = renderSummary(harness, harness.sessionManager.getLeafEntry(), 3);
		expect(spacer).toBe("");
		expect(line).toMatch(/^ {3}Worked for /);
	});
});
