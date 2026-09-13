import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompaction, shouldCompact } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function usage(tokens: number): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("compaction budgets on small windows", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("compacts and resumes at 20% with default retention and an intact trailing tool result", async () => {
		const output = `big-output:${"x".repeat(32000)}`;
		const tool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Return a large result for compaction verification",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 64000, maxTokens: 8192 }],
			settings: { compaction: { triggerPercent: 20 } },
			tools: [tool],
		});
		harnesses.push(harness);
		harness.setResponses([
			{
				...fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				usage: usage(8010),
			},
			(context, options) => {
				expect(JSON.stringify(context.messages)).toContain("This is the PREFIX of a turn");
				expect(options?.maxTokens).toBe(1600);
				return fauxAssistantMessage("A short summary of the original request.");
			},
			(context) => {
				const request = JSON.stringify(context.messages);
				expect(request).toContain("A short summary of the original request.");
				expect(request).not.toContain("big-request:");
				expect(context.messages.some((message) => message.role === "toolResult")).toBe(true);
				expect(request).toContain(output);
				return { ...fauxAssistantMessage("Continued successfully."), usage: usage(8500) };
			},
		]);

		await harness.session.prompt(`big-request:${"a".repeat(32000)}`);

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		const completion = harness.eventsOfType("compaction_end")[0];
		expect(completion).toMatchObject({ reason: "threshold", aborted: false, willRetry: false });
		expect(completion.result?.estimatedTokensAfter).toBeLessThan(12800);
		expect(harness.session.getLastAssistantText()).toBe("Continued successfully.");
	});

	it("uses the model budget for manual compaction while preserving the two-argument SDK preparation", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 64000, maxTokens: 8192 }],
			settings: { compaction: { enabled: false, triggerPercent: 20 } },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		for (let turn = 0; turn < 4; turn++) {
			harness.sessionManager.appendMessage({ role: "user", content: "u".repeat(8000), timestamp: Date.now() });
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("a".repeat(8000)),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage((turn + 1) * 4000),
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const entries = harness.sessionManager.getBranch();
		const settings = harness.settingsManager.getCompactionSettings();
		expect(shouldCompact(16000, 64000, { ...settings, enabled: true })).toBe(true);
		expect(prepareCompaction(entries, settings)).toBeUndefined();
		expect(prepareCompaction(entries, settings, model.contextWindow)).toBeDefined();
		harness.setResponses([
			(_context, options) => {
				expect(options?.maxTokens).toBe(2560);
				return fauxAssistantMessage("Summary of the first two turns.");
			},
		]);

		const result = await harness.session.compact();

		expect(result.estimatedTokensAfter).toBeLessThan(12800);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.settingsManager.getCompactionSettings()).toEqual(settings);
	});
});
