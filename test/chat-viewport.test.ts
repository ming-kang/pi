import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { type ChatViewportOptions, createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { TranscriptLayoutContainer } from "../src/modes/interactive/transcript-layout.ts";

function viewportOptions(): ChatViewportOptions {
	const chat = new TranscriptLayoutContainer();
	const document = new TranscriptLayoutContainer();
	document.addChild(chat);
	return {
		document,
		chat,
		pendingMessages: new Container(),
		status: new Container(),
		editor: new Container(),
		footer: new Container(),
	};
}

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport(viewportOptions());
		const hidden = createChatViewport({ ...viewportOptions(), scrollbar: "hidden" });

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});
});
