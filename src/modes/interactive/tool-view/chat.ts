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
	protected override renderChildren(width: number): Array<[Component, string[]]> {
		const rendered: Array<[Component, string[]]> = [];
		// Content rows of the previous visible tool row; undefined after any other child.
		let previousToolRows: number | undefined;
		for (const child of this.children) {
			if (!(child instanceof ToolExecutionComponent)) {
				previousToolRows = undefined;
				rendered.push([child, child.render(width)]);
				continue;
			}
			const { afterTool, afterMultilineTool, afterOther } = child.getToolRowGap();
			child.setLeadingGap(
				previousToolRows === undefined ? afterOther : previousToolRows > 1 ? afterMultilineTool : afterTool,
			);
			let lines = child.render(width);
			// Wrapped titles and images count, leading blank lines do not.
			const start = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
			if (start === -1) {
				// A row that shows nothing takes no gap and leaves the previous row in place.
				child.setLeadingGap(0);
				lines = child.render(width);
			} else {
				previousToolRows = lines.length - start;
			}
			rendered.push([child, lines]);
		}
		return rendered;
	}

	override clear(): void {
		disposeAll(this.children);
		super.clear();
	}
}

/** Pending tool rows by call ID.
 *
 * Forgetting a row here does not dispose it: `ToolChatContainer` owns the mounted rows and disposes
 * them when the chat is cleared or the mode shuts down, while a pending row that outlives its call
 * (an aborted run, a rebuilt transcript) stays mounted and must stay alive. */
export class PendingToolMap extends Map<string, ToolExecutionComponent> {}

/** Dispose every row still shown, for mode shutdown where the chat is not cleared. */
export function disposeChatRows(chat: Container): void {
	disposeAll(chat.children);
}
