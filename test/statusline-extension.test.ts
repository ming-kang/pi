import type { Usage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import statusline from "../src/extensions/statusline/index.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

interface FooterComponent {
	render(width: number): string[];
	dispose(): void;
	invalidate(): void;
}

interface FooterData {
	onBranchChange(listener: () => void): () => void;
	getGitBranch(): string | undefined;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

type FooterFactory = (tui: { requestRender(): void }, theme: Theme, footerData: FooterData) => FooterComponent;
type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

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

function entry(value: object): SessionEntry {
	return value as SessionEntry;
}

function usageEntries(): SessionEntry[] {
	return [
		entry({
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [],
				provider: "test",
				model: "model",
				usage: usage(100, 20, 50, 10, 0.1),
			},
		}),
		entry({
			type: "message",
			id: "tool",
			parentId: "assistant",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "toolResult", content: [], usage: usage(30, 2, 3, 4, 0.2) },
		}),
		entry({
			type: "compaction",
			id: "compaction",
			parentId: "tool",
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "summary",
			firstKeptEntryId: "assistant",
			tokensBefore: 1_000,
			usage: usage(40, 5, 6, 7, 0.3),
		}),
		entry({
			type: "branch_summary",
			id: "branch",
			parentId: "compaction",
			timestamp: "2026-01-01T00:00:03.000Z",
			fromId: "assistant",
			summary: "summary",
			usage: usage(50, 8, 9, 10, 0.4),
		}),
	];
}

async function createFooter(
	entries: SessionEntry[],
	statuses: ReadonlyMap<string, string> = new Map(),
): Promise<FooterComponent> {
	let sessionStart: SessionStartHandler | undefined;
	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
		},
	} as unknown as ExtensionAPI;
	statusline(api);

	let footerFactory: FooterFactory | undefined;
	const ctx = {
		mode: "tui",
		cwd: "/workspace/project",
		model: { id: "model", name: "Model", provider: "test", reasoning: false, contextWindow: 1_000 },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getLeafId: () => entries.at(-1)?.id ?? null,
			getBranch: () => entries,
		},
		getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
		ui: {
			setFooter: (factory: FooterFactory | undefined) => {
				footerFactory = factory;
			},
		},
	} as unknown as ExtensionContext;
	if (!sessionStart) throw new Error("session_start was not registered");
	await sessionStart({}, ctx);
	if (!footerFactory) throw new Error("footer was not installed");

	const identityTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getThinkingBorderColor: () => (text: string) => text,
	} as unknown as Theme;
	return footerFactory({ requestRender() {} }, identityTheme, {
		onBranchChange: () => () => {},
		getGitBranch: () => "feature/long-statusline-branch",
		getExtensionStatuses: () => statuses,
	});
}

describe("statusline usage", () => {
	it("includes assistant, tool, compaction, and branch-summary usage while keeping assistant cache-hit semantics", async () => {
		const footer = await createFooter(usageEntries());
		const lines = footer.render(200);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("↑220 ↓35 R68 W31 CH31.3% $1.000");
		footer.dispose();
	});

	it("refreshes after a ledger append and branch change, counting duplicates once without changing parent CH or CTX", async () => {
		const entries = usageEntries();
		const footer = await createFooter(entries);
		expect(footer.render(200)[1]).toContain("$1.000");
		const record = entry({
			type: "custom",
			id: "ledger",
			parentId: "branch",
			timestamp: "2026-01-01T00:00:04.000Z",
			customType: "background-usage",
			data: { version: 1, taskId: "group", usage: usage(500, 100, 900, 0, 2) },
		});
		entries.push(record);
		expect(footer.render(200)[1]).toContain("↑720 ↓135 R968 W31 CH31.3% $3.000");
		expect(footer.render(200)[1]).toContain("CTX 10.0%/1.0k");
		entries.push(entry({ ...record, id: "duplicate", parentId: "ledger" }));
		expect(footer.render(200)[1]).toContain("$3.000");
		entries.splice(4);
		footer.invalidate();
		expect(footer.render(200)[1]).toContain("↑220 ↓35 R68 W31 CH31.3% $1.000");
		footer.dispose();
	});

	it.each([12, 20, 40, 80, 120])("keeps both footer lines width-safe at %i columns", async (width) => {
		const footer = await createFooter(
			usageEntries(),
			new Map([
				["background", "bg 2 running · 1 waiting for input · 4 done"],
				["todo", "todo 3/8"],
			]),
		);
		const lines = footer.render(width);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		footer.dispose();
	});
});
