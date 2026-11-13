import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import statusline from "../src/extensions/statusline/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";
import { createHarness, createTestUiContext } from "./suite/harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

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

it("updates live decode TPS while streaming, reconciles at message_end, survives reload, and clears on model change", async () => {
	initTheme("dark");
	let footer: ReturnType<FooterFactory> | undefined;
	const tui = new TuiMainScreen(new VirtualTerminal());
	const footerData: ReadonlyFooterDataProvider = {
		onBranchChange: () => () => {},
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
	};
	const renderLine2 = () => {
		if (!footer) throw new Error("Missing statusline");
		return stripTerminalSequences(footer.render(200)[1]!);
	};

	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const streamingSnapshots: string[] = [];
	let chunkIndex = 0;

	const harness = await createHarness({
		models: [
			{ id: "model-a", name: "Model A", reasoning: true },
			{ id: "model-b", name: "Model B", reasoning: true },
		],
		extensionFactories: [
			(pi) => {
				pi.on("message_start", (event) => {
					if (event.message.role === "assistant") {
						chunkIndex = 0;
						now = 1_500;
					}
				});
				pi.on("message_update", (event) => {
					if (event.assistantMessageEvent.type !== "text_delta") return;
					chunkIndex++;
					now = chunkIndex === 1 ? 2_000 : 2_000 + chunkIndex * 250;
				});
				pi.on("message_end", (event) => {
					if (event.message.role === "assistant") now = 3_000;
				});
			},
			statusline,
			(pi) => {
				pi.on("message_update", () => {
					streamingSnapshots.push(renderLine2());
				});
				pi.on("message_end", (event) => {
					if (event.message.role !== "assistant") return;
					return {
						message: {
							...event.message,
							usage: {
								input: 10,
								output: 125,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 135,
								cost: { input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.01 },
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
		});
		harness.setResponses([
			fauxAssistantMessage(
				"This streamed response has enough characters across several chunks to measure live decode TPS.",
			),
		]);
		await harness.session.prompt("measure");

		expect(streamingSnapshots.some((line) => /TPS \d+/.test(line))).toBe(true);
		expect(renderLine2()).toContain(" · TPS 125");

		await harness.session.reload();
		expect(renderLine2()).toContain(" · TPS 125");

		await harness.session.setModel(harness.getModel("model-b")!);
		expect(renderLine2()).not.toContain("TPS");
	} finally {
		footer?.dispose?.();
		harness.cleanup();
	}
});
