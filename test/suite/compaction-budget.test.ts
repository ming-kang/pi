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
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context, options) => {
				// Regression test for #9652: clear boundaries and continuation wording avoid the reasoning-extraction false positive.
				expect(JSON.stringify(context.messages)).toContain("# Conversation\\n[User]: big-request:");
				expect(JSON.stringify(context.messages)).toContain(
					"# Instructions\\nThe messages above are earlier context from an ongoing conversation.",
				);
				// The 80% reserve exceeds the model's own output limit, which then caps the summary.
				expect(options?.maxTokens).toBe(8192);
				return fauxAssistantMessage("A short summary of the original request.");
			},
			(context) => {
				const request = JSON.stringify(context.messages);
				expect(request).toContain("A short summary of the original request.");
				expect(request).not.toContain("big-request:");
				expect(context.messages.some((message) => message.role === "toolResult")).toBe(true);
				expect(request).toContain(output);
				// Fresh provider usage must be checked even if the fixture completes within one millisecond.
				return fauxAssistantMessage("Continued successfully.", { timestamp: Date.now() + 1 });
			},
		]);

		await harness.session.prompt(`big-request:${"a".repeat(32000)}`);

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		const completion = harness.eventsOfType("compaction_end")[0];
		expect(completion).toMatchObject({ reason: "threshold", aborted: false, willRetry: false });
		expect(completion.result?.estimatedTokensAfter).toBeLessThan(12800);
		const lastAssistant = harness.session.messages.filter((message) => message.role === "assistant").at(-1);
		expect(lastAssistant?.usage.totalTokens).toBeLessThan(12800);
		expect(harness.session.getLastAssistantText()).toBe("Continued successfully.");
	});

	it("uses the model window budget for manual compaction", async () => {
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
		const settings = harness.settingsManager.getCompactionSettings(model);
		// A 20% trigger on a 64K window reserves the remaining 80% and retains at most half the line.
		expect(settings).toEqual({ enabled: false, reserveTokens: 51200, keepRecentTokens: 6400 });
		expect(shouldCompact(16000, 64000, { ...settings, enabled: true })).toBe(true);
		expect(prepareCompaction(entries, settings)).toBeDefined();
		// Without the model window, the default 20K retention keeps this whole session.
		expect(prepareCompaction(entries, harness.settingsManager.getCompactionSettings())).toBeUndefined();
		harness.setResponses([
			(_context, options) => {
				expect(options?.maxTokens).toBe(8192);
				return fauxAssistantMessage("Summary of the first two turns.");
			},
		]);

		const result = await harness.session.compact();

		expect(result.estimatedTokensAfter).toBeLessThan(12800);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.settingsManager.getCompactionSettings(model)).toEqual(settings);
	});
});
