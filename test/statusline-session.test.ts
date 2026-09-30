import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import statusline from "../src/extensions/statusline/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";
import { createHarness, createTestUiContext } from "./suite/harness.ts";

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

it("shows finalized usage after streaming and preserves it through reload", async () => {
	initTheme("dark");
	let footer: ReturnType<FooterFactory> | undefined;
	const tui = new TuiMainScreen(new VirtualTerminal());
	const listeners = new Set<() => void>();
	const footerData: ReadonlyFooterDataProvider = {
		onBranchChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
	};
	const render = () => {
		if (!footer) throw new Error("Missing statusline");
		return footer.render(200).map(stripTerminalSequences);
	};
	const duringStreaming: string[] = [];
	const errors: string[] = [];
	const harness = await createHarness({
		models: [{ id: "test", name: "Test model", reasoning: true }],
		extensionFactories: [
			statusline,
			(pi) => {
				pi.on("message_update", () => {
					duringStreaming.push(render()[1]);
				});
				pi.on("message_end", (event) => {
					if (event.message.role !== "assistant") return;
					return {
						message: {
							...event.message,
							usage: {
								input: 10,
								output: 5,
								cacheRead: 90,
								cacheWrite: 0,
								totalTokens: 105,
								cost: { input: 0.025, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.125 },
							},
						},
					};
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setFooter(factory) {
					footer?.dispose?.();
					footer = factory?.(tui, theme, footerData);
				},
			}),
			onError: (error) => {
				errors.push(error.error);
			},
		});
		harness.session.setThinkingLevel("high");
		expect(render()[0]).toContain(" · high");
		harness.setResponses([
			fauxAssistantMessage("First streamed answer"),
			fauxAssistantMessage("Second streamed answer"),
		]);
		await harness.session.prompt("first");
		expect(duringStreaming.length).toBeGreaterThan(0);
		expect(duringStreaming.every((line) => !line.includes("$"))).toBe(true);
		expect(render()[1]).toContain("↑10 ↓5 R90 CH90.0% $0.125");
		duringStreaming.length = 0;
		await harness.session.prompt("second");
		expect(duringStreaming.length).toBeGreaterThan(0);
		expect(duringStreaming.every((line) => line.includes("$0.125"))).toBe(true);
		expect(render()[1]).toContain("↑20 ↓10 R180 CH90.0% $0.250");
		const beforeReload = render();
		await harness.session.reload();
		expect(render()).toEqual(beforeReload);
		expect(listeners.size).toBe(1);
		harness.session.setThinkingLevel("low");
		expect(render()[0]).toContain(" · low");
		expect(errors).toEqual([]);
	} finally {
		footer?.dispose?.();
		harness.cleanup();
	}
	expect(listeners.size).toBe(0);
});
