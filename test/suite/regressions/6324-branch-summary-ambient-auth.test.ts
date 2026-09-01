import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #6324 branch summary ambient auth", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("summarizes tree branches when request auth has no API key", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		let streamCallCount = 0;
		harness.session.agent.streamFunction = (model, _context, options) => {
			streamCallCount++;
			expect(options?.apiKey).toBeUndefined();

			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "branch summary text" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(streamCallCount).toBe(1);
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toContain("branch summary text");
		expect(result.summaryEntry?.usage?.cost.total).toBe(0.25);
	});

	it("keeps the captured stream while branch-summary auth is pending", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		let capturedStreamCallCount = 0;
		harness.session.agent.streamFunction = (model) => {
			capturedStreamCallCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "captured branch summary" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		let markAuthStarted: () => void = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let releaseAuth: () => void = () => {};
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async () => {
			markAuthStarted();
			await authReleased;
			return undefined;
		});

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));
		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await authStarted;
		let replacementStreamCallCount = 0;
		harness.session.agent.streamFunction = () => {
			replacementStreamCallCount++;
			return createAssistantMessageEventStream();
		};
		releaseAuth();
		const result = await navigation;

		expect(capturedStreamCallCount).toBe(1);
		expect(replacementStreamCallCount).toBe(0);
		expect(result.summaryEntry?.summary).toContain("captured branch summary");
	});
});
