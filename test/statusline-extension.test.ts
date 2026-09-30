import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import statusline from "../src/extensions/statusline/index.ts";
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
		modelRegistry: { isUsingOAuth: () => options.subscription ?? false },
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
		const record = { version: 1, taskId: "group", usage: usage(500, 100, 900, 0, 2) };
		session.appendCustomEntry("task-usage", record);
		expect(footer.render(200)[1]).toContain("↑720 ↓135 R968 W31 CH31.3% $3.000");
		expect(footer.render(200)[1]).toContain("CTX 10.0%/1.0k");
		session.appendCustomEntry("task-usage", record);
		expect(footer.render(200)[1]).toContain("$3.000");
		session.branch(branch);
		expect(footer.render(200)[1]).toContain("↑220 ↓35 R68 W31 CH31.3% $1.000");
		footer.dispose();
	});

	it.each([12, 20, 40, 80, 120])("keeps both footer lines width-safe at %i columns", async (width) => {
		const footer = await createFooter(
			usageSession(),
			new Map([
				["background", "bg 2 running · 1 waiting for input · 4 done"],
				["custom", "custom 3/8"],
			]),
		);
		const lines = footer.render(width);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
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
