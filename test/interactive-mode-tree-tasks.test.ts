import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

function running(command: string): TaskSnapshot {
	return {
		id: `bash-${command.length}`,
		kind: "bash",
		title: command,
		command,
		toolCallId: "call",
		anchorId: "elsewhere",
		mode: "background",
		status: "running",
		startedAt: 0,
	};
}

/** The interactive /tree flow with a fake session whose navigation would stop `stopped`. */
function treeUI(stopped: TaskSnapshot[], confirm: boolean) {
	const sessionManager = SessionManager.inMemory();
	const targetId = sessionManager.appendMessage(userMsg("first"));
	sessionManager.appendMessage(assistantMsg("reply"));
	const selectors: TreeSelectorComponent[] = [];
	const ui = {
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		session: {
			isStreaming: false,
			isCompacting: false,
			abort: vi.fn(async () => {}),
			abortBranchSummary: vi.fn(),
			tasksStoppedByTreeNavigation: vi.fn(() => stopped),
			navigateTree: vi.fn(async () => ({ cancelled: false })),
		},
		defaultEditor: { onEscape: vi.fn() },
		editor: { getText: () => "", setText: vi.fn() },
		chatContainer: new Container(),
		ui: { terminal: { rows: 24 }, requestRender: vi.fn() },
		showSelector: (create: (done: () => void) => { component: TreeSelectorComponent }) => {
			selectors.push(create(vi.fn()).component);
		},
		showTreeSelector(initialSelectedId?: string) {
			showTreeSelector.call(ui, initialSelectedId);
		},
		showExtensionConfirm: vi.fn(async (_title: string, _message: string) => confirm),
		showExtensionSelector: vi.fn(async () => "No summary"),
		restoreQueuedMessagesToEditor: vi.fn(),
		renderInitialMessages: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
	};
	const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (
		this: typeof ui,
		initialSelectedId?: string,
	) => void;
	ui.showTreeSelector();
	return {
		ui,
		selectors,
		select: () => selectors.at(-1)!.getTreeList().onSelect!(targetId),
	};
}

describe("interactive /tree with running tasks", () => {
	beforeEach(() => initTheme("dark"));

	it("navigates without asking when no task would stop", async () => {
		const h = treeUI([], false);
		await h.select();
		expect(h.ui.showExtensionConfirm).not.toHaveBeenCalled();
		expect(h.ui.session.navigateTree).toHaveBeenCalledOnce();
	});

	it("lists the tasks it would stop and returns to the tree when declined", async () => {
		const h = treeUI([running("npm run build"), running("npm run dev\n--watch")], false);
		await h.select();
		const [title, message] = h.ui.showExtensionConfirm.mock.calls[0]!;
		expect(title).toBe("Stop 2 running tasks?");
		expect(message).toContain("npm run build");
		expect(message).toContain("npm run dev");
		expect(message).not.toContain("--watch");
		expect(h.ui.session.navigateTree).not.toHaveBeenCalled();
		expect(h.selectors).toHaveLength(2);
	});

	it("navigates after the stop is confirmed", async () => {
		const h = treeUI([running("npm run build")], true);
		await h.select();
		expect(h.ui.showExtensionConfirm.mock.calls[0]![0]).toBe("Stop 1 running task?");
		expect(h.ui.session.navigateTree).toHaveBeenCalledOnce();
	});
});
