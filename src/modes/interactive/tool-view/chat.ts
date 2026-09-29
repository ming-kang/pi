import { type Component, Container } from "@earendil-works/pi-tui";
import { toolStyle } from "./style.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

function disposeAll(components: Iterable<unknown>): void {
	for (const component of components) {
		const disposable = component as { dispose?: () => void };
		if (typeof disposable.dispose === "function") disposable.dispose();
	}
}

/**
 * Chat container that keeps tool blocks compact and disposes them with the chat.
 *
 * A tool row leaves no blank line above it when another tool row precedes it, so a run of tool
 * calls reads as one list. Clearing the chat disposes its tool rows, so renderer timers never
 * outlive them.
 */
export class ToolChatContainer extends Container {
	override render(width: number): string[] {
		let previous: Component | undefined;
		for (const child of this.children) {
			if (child instanceof ToolExecutionComponent) {
				const { afterTool, afterOther } = toolStyle.gap;
				child.setLeadingGap(previous instanceof ToolExecutionComponent ? afterTool : afterOther);
			}
			previous = child;
		}
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
