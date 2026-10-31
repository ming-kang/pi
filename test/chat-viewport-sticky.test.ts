import { Container, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { TranscriptLayoutContainer } from "../src/modes/interactive/transcript-layout.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

function transcriptFixture(columns = 50, rows = 12) {
	const chat = new TranscriptLayoutContainer();
	const document = new TranscriptLayoutContainer();
	document.addChild(chat);
	const viewport = createChatViewport({
		document,
		chat,
		pendingMessages: new Container(),
		status: new Container(),
		editor: new Container(),
		footer: new Container(),
		scrollbar: "hidden",
		outputPad: () => 1,
	});
	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(viewport.root);
	return { chat, viewport, terminal, tui };
}

async function settle(terminal: VirtualTerminal): Promise<void> {
	// Sticky visibility can change the layout once before it converges.
	await terminal.waitForRender();
	await terminal.waitForRender();
}

describe("fullscreen sticky user message", () => {
	beforeEach(() => initTheme("dark"));

	test("pins a scrolled-past prompt and reveals its original first line on click", async () => {
		const { chat, viewport, terminal, tui } = transcriptFixture();
		chat.addChild(new UserMessageComponent("first prompt"));
		chat.addChild(new Text(Array.from({ length: 30 }, (_, index) => `answer ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		try {
			await settle(terminal);
			expect(terminal.getViewport()[0]).toContain("↑ first prompt");
			expect(terminal.getViewport().filter((line) => line.includes("first prompt"))).toHaveLength(1);

			terminal.sendInput("\x1b[<0;3;1M");
			terminal.sendInput("\x1b[<0;3;1m");
			await settle(terminal);

			expect(terminal.getViewport()[0]).toContain("first prompt");
			expect(terminal.getViewport()[0]).not.toContain("↑");
			expect(viewport.transcript.scrollTop).toBe(2);
			expect(terminal.getViewport().filter((line) => line.includes("first prompt"))).toHaveLength(1);

			viewport.transcript.scrollBy(1);
			await settle(terminal);
			expect(terminal.getViewport()[0]).toContain("↑ first prompt");
		} finally {
			tui.stop();
		}
	});

	test("stays hidden while the latest prompt first line remains visible", async () => {
		const { chat, terminal, tui } = transcriptFixture(50, 12);
		chat.addChild(new UserMessageComponent("short prompt"));
		chat.addChild(new Text("short answer", 0, 0));
		tui.start();
		try {
			await settle(terminal);
			expect(terminal.getViewport().some((line) => line.includes("short prompt"))).toBe(true);
			expect(terminal.getViewport().some((line) => line.includes("↑ short prompt"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	test("normalizes multiline whitespace in the single-line summary", async () => {
		const { chat, terminal, tui } = transcriptFixture();
		chat.addChild(new UserMessageComponent("  first line\n\n  second   line  "));
		chat.addChild(new Text(Array.from({ length: 30 }, () => "answer").join("\n"), 0, 0));
		tui.start();
		try {
			await settle(terminal);
			expect(terminal.getViewport()[0]).toContain("↑ first line second line");
		} finally {
			tui.stop();
		}
	});
});
