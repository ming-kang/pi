import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import exploreExtension from "../../src/extensions/explore/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

let harness: Harness;
afterEach(() => harness?.cleanup());

describe("Explore background delivery", () => {
	it("investigates multiple files privately and delivers one report with one usage record", async () => {
		harness = await createHarness({ extensionFactories: [exploreExtension] });
		writeFileSync(
			join(harness.tempDir, "entry.ts"),
			'import { answer } from "./value.ts";\nexport const result = answer;',
		);
		writeFileSync(join(harness.tempDir, "value.ts"), "export const answer = 42; // PRIVATE_SOURCE_MARKER");
		const respond: FauxResponseStep = (context) => {
			if (getCurrentSystemPrompt(context.messages).includes("You are Explore")) {
				if (!context.messages.some((message) => message.role === "toolResult"))
					return fauxAssistantMessage(
						[
							fauxToolCall("read", { path: "entry.ts" }, { id: "entry" }),
							fauxToolCall("read", { path: "value.ts" }, { id: "value" }),
						],
						{ stopReason: "toolUse" },
					);
				expect(JSON.stringify(context.messages)).toContain("PRIVATE_SOURCE_MARKER");
				return fauxAssistantMessage(
					"## Answer\nThe result is 42.\n\n## Source evidence\nentry.ts:1 imports value.ts:1.",
				);
			}
			expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_SOURCE_MARKER");
			if (!context.messages.some((message) => message.role === "toolResult"))
				return fauxAssistantMessage(
					fauxToolCall(
						"explore",
						{ query: "Trace how result is defined", background: true },
						{ id: "investigate" },
					),
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage("Main agent continues with the available results.");
		};
		harness.setResponses(Array.from({ length: 10 }, () => respond));
		await harness.session.bindExtensions({ tasksEnabled: true });
		expect(harness.session.tasks.views.get("explore")).toBeDefined();
		await harness.session.prompt("Investigate result while I work independently.");
		const notices = () =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "task-completion");
		await vi.waitFor(() => expect(notices()).toHaveLength(1));
		await harness.session.waitForIdle();
		const task = harness.session.tasks.list()[0]!;
		expect(task.status).toBe("completed");
		expect(getMessageText(task.result)).toContain("value.ts:1");
		const entries = harness.sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "task-usage")).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "task-result")).toHaveLength(1);
		expect(notices()).toHaveLength(1);
	});
});
