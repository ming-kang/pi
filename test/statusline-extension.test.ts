import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import statusline from "../src/extensions/statusline/index.ts";
import { renderStatusline, type StatuslineData } from "../src/extensions/statusline/render.ts";
import { TpsTracker } from "../src/extensions/statusline/tps.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
type FooterComponent = ReturnType<FooterFactory>;
type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
const cleanups: Array<() => void> = [];
beforeAll(() => initTheme("dark"));
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(accountedUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "model",
		stopReason: "stop",
		timestamp: 0,
		usage: accountedUsage,
	};
}

function usageSession(): SessionManager {
	const session = SessionManager.inMemory();
	const first = session.appendMessage(assistant(usage(100, 20, 50, 10, 0.1)));
	session.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "test",
		content: [],
		isError: false,
		timestamp: 0,
		usage: usage(30, 2, 3, 4, 0.2),
	});
	session.appendCompaction("summary", first, 1_000, undefined, undefined, usage(40, 5, 6, 7, 0.3));
	session.branchWithSummary(session.getLeafId(), "summary", undefined, undefined, usage(50, 8, 9, 10, 0.4));
	return session;
}

async function createFooter(
	sessionManager = SessionManager.inMemory(),
	statuses: ReadonlyMap<string, string> = new Map(),
	options: {
		percent?: number | null;
		cwd?: string;
		branch?: string | null;
		reasoning?: boolean;
		subscription?: boolean;
	} = {},
) {
	const handlers = new Map<string, SessionStartHandler>();
	const api = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler as SessionStartHandler);
		},
	} as unknown as ExtensionAPI;
	statusline(api);

	let component: FooterComponent | undefined;
	const listeners = new Set<() => void>();
	const tui = new TuiMainScreen(new VirtualTerminal());
	const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
	const footerData: ReadonlyFooterDataProvider = {
		onBranchChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getGitBranch: () => (options.branch === undefined ? "feature/long-statusline-branch" : options.branch),
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
	};
	const setFooter: ExtensionUIContext["setFooter"] = (factory) => {
		component?.dispose?.();
		component = factory?.(tui, theme, footerData);
	};
	const percent = options.percent === undefined ? 10 : options.percent;
	const model: Model<"openai-completions"> = {
		id: "model",
		name: "Model",
		provider: "test",
		reasoning: options.reasoning ?? false,
		contextWindow: 1_000,
		api: "openai-completions",
		baseUrl: "https://test.invalid",
		input: ["text"],
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const ctx = {
		mode: "tui",
		cwd: options.cwd ?? "/workspace/project",
		model,
		thinkingLevel: "off",
		modelRuntime: {
			isUsingSubscription: (providerId: string) => options.subscription ?? providerId === "kimi-coding",
		},
		sessionManager,
		getContextUsage: () => ({ tokens: percent === null ? null : percent * 10, contextWindow: 1_000, percent }),
		ui: { setFooter },
	} as unknown as ExtensionContext;
	const emit = async (event: string) => {
		const handler = handlers.get(event);
		if (!handler) throw new Error(`${event} was not registered`);
		await handler({}, ctx);
	};
	await emit("session_start");
	const current = () => {
		if (!component) throw new Error("footer was not installed");
		return component;
	};
	cleanups.push(() => component?.dispose?.());
	return {
		ctx,
		model,
		listeners,
		requestRender,
		emit,
		render: (width: number) => current().render(width).map(stripTerminalSequences),
		renderStyled: (width: number) => current().render(width),
		invalidate: () => current().invalidate(),
		dispose: () => setFooter(undefined),
		installed: () => component !== undefined,
	};
}

describe("statusline usage", () => {
	it("includes assistant, tool, compaction, and branch-summary usage while keeping assistant cache-hit semantics", async () => {
		const footer = await createFooter(usageSession());
		const lines = footer.render(200);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("↑220 ↓35 R68 W31 CH31.3% $1.000");
		footer.dispose();
	});

	it("refreshes after a ledger append and branch change, counting duplicates once without changing parent CH or CTX", async () => {
		const session = usageSession();
		const branch = session.getLeafId()!;
		const footer = await createFooter(session);
		expect(footer.render(200)[1]).toContain("$1.000");
		const record = { version: 3, task: { id: "group" }, usage: usage(500, 100, 900, 0, 2) };
		session.appendCustomEntry("task-record", record);
		expect(footer.render(200)[1]).toContain("↑720 ↓135 R968 W31 CH31.3% $3.000");
		expect(footer.render(200)[1]).toContain("CTX 10.0%/1.0k");
		session.appendCustomEntry("task-record", record);
		expect(footer.render(200)[1]).toContain("$3.000");
		session.branch(branch);
		expect(footer.render(200)[1]).toContain("↑220 ↓35 R68 W31 CH31.3% $1.000");
		footer.dispose();
	});
});

describe("statusline context colors", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		[0, "accent"],
		[40, "accent"],
		[40.1, "warning"],
		[80, "warning"],
		[80.1, "error"],
		[95, "error"],
		[null, "accent"],
	] as const)("renders %s percent with the %s theme color", async (percent, color) => {
		const footer = await createFooter(undefined, new Map(), { percent });
		const label = `CTX ${percent === null ? "?" : percent.toFixed(1)}%/1.0k`;
		expect(footer.renderStyled(200)[1]).toContain(theme.fg(color, label));
		footer.dispose();
	});
});

describe("statusline branch and lifecycle", () => {
	it("accounts standalone usage without replacing the latest assistant cache hit", async () => {
		const session = usageSession();
		const footer = await createFooter(session);
		session.appendUsage("retry", "test", "model", usage(10, 5, 0, 0, 0.5));
		expect(footer.render(200)[1]).toContain("↑230 ↓40 R68 W31 CH31.3% $1.500");
		session.appendMessage(assistant(usage(10, 1, 0, 0, 0)));
		expect(footer.render(200)[1]).not.toContain("CH");
	});

	it("counts write-only cache usage and the latest failed assistant request", async () => {
		const session = usageSession();
		session.appendMessage({ ...assistant(usage(10, 0, 0, 10, 0.2)), stopReason: "error" });
		const footer = await createFooter(session);
		expect(footer.render(200)[1]).toContain("CH0.0% $1.200");
	});

	it("reuses branch accounting across paints and refreshes on invalidate", async () => {
		const session = usageSession();
		const getBranch = vi.spyOn(session, "getBranch");
		const footer = await createFooter(session);
		const initial = footer.render(200);
		footer.render(80);
		expect(getBranch).toHaveBeenCalledTimes(1);
		footer.invalidate();
		expect(footer.render(200)).toEqual(initial);
		expect(getBranch).toHaveBeenCalledTimes(2);
		session.resetLeaf();
		expect(footer.render(200)[1].trim()).toBe("CTX 10.0%/1.0k");
	});

	it("reads live thinking level without requiring a history entry", async () => {
		const footer = await createFooter(undefined, undefined, { reasoning: true });
		footer.ctx.thinkingLevel = "high";
		expect(footer.render(200)[0]).toContain("Model (test) · high");
		footer.ctx.thinkingLevel = "low";
		expect(footer.render(200)[0]).toContain("Model (test) · low");
		footer.model.reasoning = false;
		expect(footer.render(200)[0]).not.toContain(" · low");
		footer.model.reasoning = true;
		footer.ctx.thinkingLevel = "off";
		expect(footer.render(200)[0]).not.toContain(" · off");
	});

	it("replaces the footer without accumulating Git subscriptions and clears it on shutdown", async () => {
		const footer = await createFooter();
		expect(footer.listeners.size).toBe(1);
		await footer.emit("session_start");
		expect(footer.listeners.size).toBe(1);
		for (const listener of footer.listeners) listener();
		expect(footer.requestRender).toHaveBeenCalledTimes(1);
		await footer.emit("session_shutdown");
		expect(footer.installed()).toBe(false);
		expect(footer.listeners.size).toBe(0);
	});

	it.each(["print", "rpc", "json"] as const)("does not install a footer in %s mode", async (mode) => {
		const footer = await createFooter();
		footer.dispose();
		footer.ctx.mode = mode;
		await footer.emit("session_start");
		expect(footer.installed()).toBe(false);
	});
});

describe("statusline layout", () => {
	it.each([
		[40, "Model (test)", "/long/parent/project · main"],
		[39, "Model (test)", "/long/parent/project"],
		[32, "Model (test)", "project · main"],
		[26, "Model (test)", "project"],
		[19, "Model", "project"],
		[12, "Model", ""],
	] as const)("preserves primary choices at %i columns", async (width, left, right) => {
		const footer = await createFooter(undefined, undefined, { cwd: "/long/parent/project", branch: "main" });
		expect(footer.render(width)[0]).toBe(
			right ? `${left}${" ".repeat(width - left.length - right.length)}${right}` : left,
		);
	});

	it("drops status before W and R, then truncates the full usage candidate", async () => {
		const footer = await createFooter(usageSession(), new Map([["task", "busy"]]));
		const context = "CTX 10.0%/1.0k";
		const full = "↑220 ↓35 R68 W31 CH31.3% $1.000";
		const withoutWrite = "↑220 ↓35 R68 CH31.3% $1.000";
		const withoutRead = "↑220 ↓35 CH31.3% $1.000";
		expect(footer.render(context.length + full.length + 6)[1]).toContain("busy");
		for (const candidate of [full, withoutWrite, withoutRead]) {
			expect(footer.render(context.length + candidate.length + 1)[1]).toBe(`${context} ${candidate}`);
		}
		const truncated = footer.render(context.length + withoutRead.length)[1];
		expect(truncated).toContain("R68");
		expect(truncated).toContain("...");
		expect(truncated).not.toContain("busy");
	});

	it("pins status to the absolute center as usage grows and balances when sides collide", async () => {
		const session = SessionManager.inMemory();
		const footer = await createFooter(session, new Map([["task", "busy"]]));
		expect(footer.render(120)[1].indexOf("busy")).toBe(58);
		session.appendMessage(assistant(usage(100, 20, 50, 10, 0.1)));
		expect(footer.render(120)[1].indexOf("busy")).toBe(58);
		const line = footer.render(55)[1];
		expect(line.indexOf("busy")).toBe(17);
		expect(line.endsWith("$0.100")).toBe(true);
	});

	it("sorts and flattens statuses while retaining extension colors", async () => {
		const colored = theme.fg("success", "colored");
		const footer = await createFooter(
			undefined,
			new Map([
				["z", colored],
				["a", " plain\n\tstatus "],
				["empty", " \n "],
			]),
		);
		expect(footer.render(100)[1]).toContain("plain status  colored");
		expect(footer.renderStyled(100)[1]).toContain(`${theme.fg("muted", "plain status")}  ${colored}`);
	});

	it("keeps Unicode and colored lines within every width from zero to 120", async () => {
		const footer = await createFooter(usageSession(), new Map([["task", theme.fg("accent", "任务 🙂")]]), {
			cwd: "/项目/文件夹",
			branch: "分支",
		});
		footer.model.name = "模型 🙂";
		for (let width = 0; width <= 120; width++) {
			const lines = footer.renderStyled(width);
			expect(lines).toHaveLength(2);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it.each([
		["C:\\Users\\test\\project", "C:\\Users\\test", "~/project"],
		["/home/test/project", "/home/test", "~/project"],
		["/home/test2/project", "/home/test", "/home/test2/project"],
		["/home/test", "/home/test", "~"],
	])("formats home-relative paths for %s", async (cwd, home, expected) => {
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("HOME", home);
		const footer = await createFooter(undefined, undefined, { cwd, branch: null });
		expect(footer.render(100)[0].endsWith(expected)).toBe(true);
	});

	it("shows OAuth cost labels and falls back when model or context is absent", async () => {
		const footer = await createFooter(usageSession(), undefined, { subscription: true });
		expect(footer.render(200)[1]).toContain("$1.000 (sub)");
		footer.ctx.getContextUsage = () => undefined;
		expect(footer.render(200)[1]).toContain("CTX ?%/1.0k");
		footer.ctx.model = undefined;
		expect(footer.render(200)[0]).toContain("no-model");
		expect(footer.render(200)[1]).toContain("CTX ?%");
		expect(footer.render(200)[1]).not.toContain("(sub)");
	});
});

describe("statusline TPS display and layout", () => {
	function renderWithTps(tps: number | undefined, width = 120, options: Partial<StatuslineData> = {}) {
		const data: StatuslineData = {
			model: { id: "model", name: "Model", provider: "test", reasoning: false, contextWindow: 1_000 },
			thinkingLevel: "off",
			cwd: "/workspace/project",
			home: "/home/test",
			gitBranch: null,
			contextUsage: { tokens: 151, contextWindow: 1_000, percent: 15.1 },
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				latestCacheHitPercent: undefined,
			},
			tps,
			usesSubscription: false,
			statuses: new Map(),
			...options,
		};
		return renderStatusline(data, theme, width);
	}

	it.each([
		[0, 0, "thinkingLow"],
		[48.4, 48, "thinkingLow"],
		[49.6, 50, "thinkingMedium"],
		[99.4, 99, "thinkingMedium"],
		[100, 100, "thinkingHigh"],
		[149.4, 149, "thinkingHigh"],
		[150, 150, "thinkingXhigh"],
		[199.4, 199, "thinkingXhigh"],
		[200, 200, "thinkingMax"],
		[342.8, 343, "thinkingMax"],
	] as const)("renders rounded TPS %s as %i with %s tier color", (tps, expectedInt, token) => {
		const styled = renderWithTps(tps)[1]!;
		const plain = stripTerminalSequences(styled);
		expect(plain).toContain(`CTX 15.1%/1.0k · TPS ${expectedInt}`);
		expect(styled).toContain(theme.fg("dim", " · "));
		expect(styled).toContain(theme.fg(token, `TPS ${expectedInt}`));
	});

	it("drops TPS before CTX or shortest usage on narrow widths", () => {
		const fullUsage = {
			input: 220,
			output: 35,
			cacheRead: 68,
			cacheWrite: 31,
			cost: 1,
			latestCacheHitPercent: 31.3,
		};
		const context = "CTX 15.1%/1.0k";
		const leftWithTps = `${context} · TPS 84`;
		const shortestUsage = "↑220 ↓35 CH31.3% $1.000";

		// Fits CTX + TPS + shortest usage cleanly when width allows.
		const withTpsLine = stripTerminalSequences(
			renderWithTps(84, leftWithTps.length + 1 + shortestUsage.length, { usage: fullUsage })[1]!,
		);
		expect(withTpsLine).toBe(`${leftWithTps} ${shortestUsage}`);

		// Drops TPS so CTX and shortest usage still fit without truncation.
		const droppedTpsLine = stripTerminalSequences(
			renderWithTps(84, context.length + 1 + shortestUsage.length, { usage: fullUsage })[1]!,
		);
		expect(droppedTpsLine).toBe(`${context} ${shortestUsage}`);
		expect(droppedTpsLine).not.toContain("TPS");

		// Drops TPS when no usage exists and CTX · TPS alone overflows width.
		const narrowNoUsage = stripTerminalSequences(renderWithTps(84, context.length + 2)[1]!);
		expect(narrowNoUsage.startsWith(context)).toBe(true);
		expect(narrowNoUsage).not.toContain("TPS");
	});
});

describe("statusline TpsTracker", () => {
	function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "test",
			model: "model-a",
			stopReason: "stop",
			timestamp: 1_000,
			usage: usage(10, 0, 0, 0, 0),
			...overrides,
		};
	}

	it("measures decode-only TPS (excluding TTFT), counts text/thinking/tool deltas, and reconciles with final usage", () => {
		let clock = 1_000;
		const tracker = new TpsTracker(() => clock);
		const session = SessionManager.inMemory();
		const msg = makeAssistant({ timestamp: 5_000 });

		tracker.onSessionStart(session.getSessionId(), "startup");
		tracker.onMessageStart("assistant");

		// Empty delta must not start decode timing.
		expect(
			tracker.onMessageUpdate("assistant", { type: "text_delta", contentIndex: 0, delta: "", partial: msg }),
		).toBe(false);
		clock = 3_000; // 2s TTFT before first non-empty token.

		// First token arrives at 3000ms (CJK=2 chars -> 2 tokens, plus ASCII=8 chars -> 2 tokens).
		expect(
			tracker.onMessageUpdate("assistant", { type: "thinking_delta", contentIndex: 0, delta: "思考", partial: msg }),
		).toBe(false);
		clock = 3_100; // < 250ms live threshold.
		expect(
			tracker.onMessageUpdate("assistant", {
				type: "text_delta",
				contentIndex: 1,
				delta: "abcdefgh",
				partial: msg,
			}),
		).toBe(false);
		expect(tracker.read(session)).toBeUndefined();

		// At 3300ms (300ms decode), estimated = 4 tokens -> ~13.3 TPS; throttled for next 200ms.
		clock = 3_300;
		expect(
			tracker.onMessageUpdate("assistant", {
				type: "toolcall_delta",
				contentIndex: 2,
				delta: '{"a":123}', // 9 chars -> +2.25 tokens -> 6.25 total / 0.3s = 20.83
				partial: msg,
			}),
		).toBe(true);
		expect(tracker.read(session)).toBeCloseTo(6.25 / 0.3, 5);

		clock = 3_400; // Only 100ms since last sample -> throttled.
		expect(
			tracker.onMessageUpdate("assistant", { type: "text_delta", contentIndex: 1, delta: "1234", partial: msg }),
		).toBe(false);

		// Message ends at 4000ms (1000ms pure decode, excluding 2000ms TTFT) with provider usage.output = 80 -> 80 TPS.
		clock = 4_000;
		const finalized = makeAssistant({ timestamp: 5_000, usage: usage(10, 80, 0, 0, 0.1) });
		expect(tracker.onMessageEnd(finalized)).toBe(true);
		expect(tracker.read(session)).toBeCloseTo(80, 5);
	});

	it("reconciles later message_end usage mutations via session branch and keeps previous TPS on error", () => {
		let clock = 0;
		const tracker = new TpsTracker(() => clock);
		const session = SessionManager.inMemory();

		tracker.onSessionStart(session.getSessionId(), "startup");
		tracker.onMessageStart("assistant");
		clock = 100;
		tracker.onMessageUpdate("assistant", {
			type: "text_delta",
			contentIndex: 0,
			delta: "hello world!",
			partial: makeAssistant(),
		});
		clock = 600; // 500ms decode.
		const ended = makeAssistant({ timestamp: 2_000, usage: usage(10, 0, 0, 0, 0) });
		expect(tracker.onMessageEnd(ended)).toBe(false);
		session.appendMessage({ ...ended, usage: usage(10, 45, 0, 0, 0.1) });
		expect(tracker.read(session)).toBeCloseTo(90, 5);

		// Next turn errors before producing any output -> preserve previous valid TPS (90).
		tracker.onMessageStart("assistant");
		clock = 1_500;
		const errored = makeAssistant({ timestamp: 3_000, stopReason: "error", usage: usage(10, 0, 0, 0, 0) });
		tracker.onMessageEnd(errored);
		session.appendMessage(errored);
		expect(tracker.read(session)).toBeCloseTo(90, 5);
	});

	it("clears on model_select and preserves TPS across reload", () => {
		let clock = 0;
		const tracker = new TpsTracker(() => clock);
		const session = SessionManager.inMemory();
		const sessionId = session.getSessionId();

		tracker.onSessionStart(sessionId, "startup");
		tracker.onMessageStart("assistant");
		clock = 100;
		tracker.onMessageUpdate("assistant", {
			type: "text_delta",
			contentIndex: 0,
			delta: "abcd",
			partial: makeAssistant(),
		});
		clock = 1_100; // 1000ms decode.
		tracker.onMessageEnd(makeAssistant({ timestamp: 1_000, usage: usage(5, 60, 0, 0, 0) }));
		expect(tracker.read(session)).toBeCloseTo(60, 5);

		// Reload preserves TPS.
		tracker.onSessionShutdown(sessionId, "reload");
		const reloaded = new TpsTracker(() => clock);
		reloaded.onSessionStart(sessionId, "reload");
		expect(reloaded.read(session)).toBeCloseTo(60, 5);

		// Switching model immediately clears TPS.
		reloaded.onModelSelect({ provider: "other", id: "model-b" }, { provider: "test", id: "model-a" });
		expect(reloaded.read(session)).toBeUndefined();

		// Non-reload shutdown drops preserved state.
		reloaded.onSessionShutdown(sessionId, "quit");
		reloaded.onSessionStart(sessionId, "startup");
		expect(reloaded.read(session)).toBeUndefined();
	});
});
