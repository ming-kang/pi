import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolResultEvent,
	ToolResultEventResult,
} from "../src/core/extensions/types.ts";
import { WEB_SEARCH_TOOL_NAME } from "../src/extensions/web-search/constants.ts";
import webSearch from "../src/extensions/web-search/index.ts";
import type { WebSearchParamsSchema } from "../src/extensions/web-search/schema.ts";
import type { ResolvedSearchCredentials, WebSearchDetails } from "../src/extensions/web-search/types.ts";

const resolveSearchCredentialsMock = vi.hoisted(() => vi.fn<() => Promise<ResolvedSearchCredentials>>());
vi.mock("../src/extensions/web-search/auth.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extensions/web-search/auth.ts")>();
	return { ...actual, resolveSearchCredentials: resolveSearchCredentialsMock };
});

type WebSearchTool = ToolDefinition<typeof WebSearchParamsSchema, WebSearchDetails>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function setup(initialActive: string[]) {
	let active = [...initialActive];
	let tool: WebSearchTool | undefined;
	const handlers = new Map<string, EventHandler>();
	const setActiveTools = vi.fn((toolNames: string[]) => {
		active = [...toolNames];
	});
	const pi = {
		registerTool: (definition: WebSearchTool) => {
			tool = definition;
		},
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		getActiveTools: () => [...active],
		setActiveTools,
	} as unknown as ExtensionAPI;
	webSearch(pi);
	if (!tool) throw new Error("web_search tool was not registered");
	return { handlers, setActiveTools, tool, activeTools: () => [...active] };
}

function context(): ExtensionContext {
	return { modelRuntime: {} } as unknown as ExtensionContext;
}

function resultEvent(status: WebSearchDetails["status"]): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: WEB_SEARCH_TOOL_NAME,
		toolCallId: "call-1",
		input: { query: "release" },
		content: [],
		details: {
			query: "release",
			durationMs: 1,
			status,
			engine: status === "disabled" ? "none" : "minimax",
			totalHits: 0,
			hits: [],
		},
		isError: false,
	};
}

describe("web_search lifecycle", () => {
	beforeEach(() => resolveSearchCredentialsMock.mockReset());
	afterEach(() => vi.restoreAllMocks());

	it("removes the active tool when a session starts without credentials", async () => {
		resolveSearchCredentialsMock.mockResolvedValue({});
		const harness = setup(["read", WEB_SEARCH_TOOL_NAME, "bash"]);
		await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context());
		expect(harness.activeTools()).toEqual(["read", "bash"]);
		expect(harness.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
	});

	it("does not rewrite the host active set when credentials are available", async () => {
		resolveSearchCredentialsMock.mockResolvedValue({ deepseek: { key: "key" } });
		const disabled = setup(["read", "bash"]);
		await disabled.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context());
		expect(disabled.activeTools()).toEqual(["read", "bash"]);
		expect(disabled.setActiveTools).not.toHaveBeenCalled();

		const enabled = setup(["read", WEB_SEARCH_TOOL_NAME, "bash"]);
		await enabled.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context());
		expect(enabled.activeTools()).toEqual(["read", WEB_SEARCH_TOOL_NAME, "bash"]);
		expect(enabled.setActiveTools).not.toHaveBeenCalled();
	});

	it("maps only terminal search failures to protocol-level tool errors", async () => {
		const harness = setup([WEB_SEARCH_TOOL_NAME]);
		const handler = harness.handlers.get("tool_result") as
			| ((event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultEventResult | undefined>)
			| undefined;
		if (!handler) throw new Error("tool_result handler was not registered");
		await expect(handler(resultEvent("error"), context())).resolves.toEqual({ isError: true });
		await expect(handler(resultEvent("disabled"), context())).resolves.toBeUndefined();
		await expect(handler(resultEvent("success"), context())).resolves.toBeUndefined();
		await expect(handler({ ...resultEvent("error"), toolName: "other" }, context())).resolves.toBeUndefined();
	});

	it("keeps execute results free of the non-contract isError field", async () => {
		resolveSearchCredentialsMock.mockResolvedValue({});
		const harness = setup([WEB_SEARCH_TOOL_NAME]);
		const result = await harness.tool.execute("call-1", { query: "" }, undefined, undefined, context());
		expect(result.details.status).toBe("error");
		expect(result).not.toHaveProperty("isError");
	});
});
