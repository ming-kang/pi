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
	const MODEL = { provider: "test", id: "model-a" };

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

	function startTracker() {
		const state = { clock: 0 };
		const tracker = new TpsTracker(() => state.clock);
		const session = SessionManager.inMemory();
		tracker.onSessionStart(session.getSessionId(), "startup");
		const delta = (
			at: number,
			text: string,
			type: "text_delta" | "thinking_delta" | "toolcall_delta" = "text_delta",
		) => {
			state.clock = at;
			return tracker.onMessageUpdate("assistant", { type, contentIndex: 0, delta: text, partial: makeAssistant() });
		};
		const end = (at: number, message: AssistantMessage) => {
			state.clock = at;
			return tracker.onMessageEnd(message);
		};
		return { state, tracker, session, delta, end };
	}

	it("excludes the whole first-token wait when every output token was streamed", () => {
		const { tracker, session, delta, end } = startTracker();
		tracker.onMessageStart("assistant");
		// 2s wait, then 1s of stream carrying an estimated 100 tokens (CJK 1/char, the rest 4 chars/token).
		delta(2_000, "思考".repeat(10), "thinking_delta");
		delta(2_500, "x".repeat(160));
		delta(3_000, "y".repeat(160), "toolcall_delta");
		end(3_000, makeAssistant({ usage: usage(10, 80, 0, 0, 0), durationMs: 3_000 }));

		expect(tracker.read(session, MODEL)).toBeCloseTo(80, 5);
	});

	it("keeps the wait in the decode time for output tokens that never streamed", () => {
		const { tracker, session, delta, end } = startTracker();
		tracker.onMessageStart("assistant");
		// 9s before the first delta, then 200 estimated tokens in 1s; the provider billed 2000.
		delta(9_000, "x".repeat(400));
		delta(10_000, "x".repeat(400));
		end(10_000, makeAssistant({ usage: usage(10, 2_000, 0, 0, 0), durationMs: 10_000 }));

		// A tenth of the output was visible, so a tenth of the wait is deducted: 2000 / 9.1s.
		// Dividing by the 1s stream window alone would report 2000.
		expect(tracker.read(session, MODEL)).toBeCloseTo(2_000 / 9.1, 5);
	});

	it("reports whole-request throughput when the stream arrives in one burst", () => {
		const { tracker, session, delta, end } = startTracker();
		tracker.onMessageStart("assistant");
		// A buffering gateway flushes everything 9s in; the 25ms window is transport, not decoding.
		delta(9_000, "x".repeat(180));
		delta(9_020, "x".repeat(180));
		end(9_025, makeAssistant({ usage: usage(10, 90, 0, 0, 0), durationMs: 9_030 }));

		expect(tracker.read(session, MODEL)).toBeCloseTo(90 / 9.03, 5);
	});

	it("reports whole-request throughput for a response with no deltas", () => {
		const { tracker, session, end } = startTracker();
		tracker.onMessageStart("assistant");
		end(4_000, makeAssistant({ usage: usage(10, 200, 0, 0, 0), durationMs: 4_000 }));

		expect(tracker.read(session, MODEL)).toBeCloseTo(50, 5);
	});

	it("falls back to the streamed rate when the provider reports no output usage", () => {
		const { tracker, session, delta, end } = startTracker();
		tracker.onMessageStart("assistant");
		delta(1_000, "x".repeat(40));
		delta(2_000, "x".repeat(240));
		end(2_000, makeAssistant({ durationMs: 2_000 }));

		// 60 tokens arrived during the 1s after the delta that opened the window.
		expect(tracker.read(session, MODEL)).toBeCloseTo(60, 5);
	});

	it("measures live TPS from the tokens after the first delta and lets it decay while the stream stalls", () => {
		const { state, tracker, session, delta } = startTracker();
		tracker.onMessageStart("assistant");

		expect(delta(500, "")).toBe(false);
		// The first delta only opens the window: its 100 tokens arrived over no measured time.
		expect(delta(2_000, "x".repeat(400))).toBe(false);
		expect(delta(2_100, "x".repeat(40))).toBe(false);
		expect(tracker.read(session, MODEL)).toBeUndefined();

		// 20 tokens over 500ms. Counting the opening delta would report 240.
		expect(delta(2_500, "x".repeat(40))).toBe(true);
		expect(tracker.read(session, MODEL)).toBeCloseTo(40, 5);

		// Render requests are throttled; the value itself is never cached.
		expect(delta(2_600, "x".repeat(40))).toBe(false);
		expect(tracker.read(session, MODEL)).toBeCloseTo(50, 5);
		state.clock = 5_000;
		expect(tracker.read(session, MODEL)).toBeCloseTo(10, 5);
	});

	it("shows nothing for a latest response it could not measure", () => {
		const { tracker, session, delta, end } = startTracker();
		tracker.onMessageStart("assistant");
		delta(1_000, "x".repeat(400));
		const measured = makeAssistant({ timestamp: 1_000, usage: usage(10, 100, 0, 0, 0), durationMs: 2_000 });
		end(2_000, measured);
		session.appendMessage(measured);
		expect(tracker.read(session, MODEL)).toBeCloseTo(100, 5);

		// The next request fails before producing output: the previous value must not stand in for it.
		tracker.onMessageStart("assistant");
		const errored = makeAssistant({ timestamp: 3_000, stopReason: "error", durationMs: 500 });
		end(2_500, errored);
		expect(tracker.read(session, MODEL)).toBeUndefined();
		session.appendMessage(errored);
		expect(tracker.read(session, MODEL)).toBeUndefined();
	});

	it("uses the persisted message when usage changes after message_end", () => {
		const { tracker, session, delta, end } = startTracker();
		tracker.onMessageStart("assistant");
		delta(1_000, "x".repeat(400));
		const ended = makeAssistant({ timestamp: 2_000, durationMs: 1_500 });
		end(1_500, ended);
		session.appendMessage({ ...ended, usage: usage(10, 45, 0, 0, 0.1) });

		expect(tracker.read(session, MODEL)).toBeCloseTo(90, 5);
	});

	it("follows the latest response on the active branch and hides it under another model", () => {
		const { tracker, session, delta, end } = startTracker();

		tracker.onMessageStart("assistant");
		delta(1_000, "x".repeat(400));
		const first = makeAssistant({ timestamp: 1_000, usage: usage(10, 60, 0, 0, 0), durationMs: 2_000 });
		end(2_000, first);
		const firstId = session.appendMessage(first);

		tracker.onMessageStart("assistant");
		delta(3_000, "x".repeat(400));
		const second = makeAssistant({ timestamp: 2_000, usage: usage(10, 90, 0, 0, 0), durationMs: 2_000 });
		end(4_000, second);
		session.appendMessage(second);
		expect(tracker.read(session, MODEL)).toBeCloseTo(90, 5);

		session.branch(firstId);
		tracker.onSessionTree();
		expect(tracker.read(session, MODEL)).toBeCloseTo(60, 5);

		expect(tracker.read(session, { provider: "other", id: "model-b" })).toBeUndefined();
		expect(tracker.read(session, MODEL)).toBeCloseTo(60, 5);
	});

	it("preserves TPS across reload and drops it when the session ends", () => {
		const { state, tracker, session, delta, end } = startTracker();
		const sessionId = session.getSessionId();
		tracker.onMessageStart("assistant");
		delta(100, "x".repeat(400));
		const message = makeAssistant({ usage: usage(5, 60, 0, 0, 0), durationMs: 1_100 });
		end(1_100, message);
		session.appendMessage(message);
		expect(tracker.read(session, MODEL)).toBeCloseTo(60, 5);

		tracker.onSessionShutdown(sessionId, "reload");
		const reloaded = new TpsTracker(() => state.clock);
		reloaded.onSessionStart(sessionId, "reload");
		expect(reloaded.read(session, MODEL)).toBeCloseTo(60, 5);

		reloaded.onSessionShutdown(sessionId, "quit");
		reloaded.onSessionStart(sessionId, "startup");
		expect(reloaded.read(session, MODEL)).toBeUndefined();
	});
});
