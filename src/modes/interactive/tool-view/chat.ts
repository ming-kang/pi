import type { Component, Container } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { ToolExecutionComponent } from "../components/tool-execution.ts";
import { TranscriptLayoutContainer } from "../transcript-layout.ts";

function disposeAll(components: Iterable<unknown>): void {
	for (const component of components) {
		const disposable = component as { dispose?: () => void };
		if (typeof disposable.dispose === "function") disposable.dispose();
	}
}

/**
 * Chat container that keeps tool blocks compact and disposes them with the chat.
 *
 * Single-line tools read as one compact list; a multiline tool leaves a blank line before the
 * next tool. Clearing the chat disposes its tool rows, so renderer timers never outlive them.
 */
export class ToolChatContainer extends TranscriptLayoutContainer {
	override render(width: number): string[] {
		let previous: Component | undefined;
		let previousHeight = 0;
		for (const child of this.children) {
			if (child instanceof ToolExecutionComponent) {
				// Measure at this width without external spacing, including wrapped titles and images.
				child.setLeadingGap(0);
				const lines = child.render(width);
				const start = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
				if (start === -1) continue;
				const { afterTool, afterMultilineTool, afterOther } = child.getToolRowGap();
				child.setLeadingGap(
					previous instanceof ToolExecutionComponent
						? previousHeight > 1
							? afterMultilineTool
							: afterTool
						: afterOther,
				);
				previousHeight = lines.length - start;
			}
			previous = child;
		}
		// Record child rows after the final tool spacing is known.
		return super.render(width);
	}

	override clear(): void {
		disposeAll(this.children);
		super.clear();
	}
}

/** Pending tool rows by call ID; clear() disposes the rows it forgets. */
export class PendingToolMap extends Map<string, ToolExecutionComponent> {
	override clear(): void {
		disposeAll(this.values());
		super.clear();
	}
}

/** Dispose every row still shown, for mode shutdown where the chat is not cleared. */
export function disposeChatRows(chat: Container): void {
	disposeAll(chat.children);
}
