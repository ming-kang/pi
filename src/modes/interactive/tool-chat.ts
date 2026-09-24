import { type Component, Container } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { keyLabel } from "./components/keybinding-hints.ts";
import { ToolExecutionComponent, type ToolExecutionOptions } from "./components/tool-execution.ts";
import { ToolGroupComponent } from "./components/tool-group.ts";

function disposeAll(components: Iterable<unknown>): void {
	for (const component of components) {
		const disposable = component as { dispose?: () => void };
		if (typeof disposable.dispose === "function") disposable.dispose();
	}
}

/** Chat container whose clear() disposes tool rows, so renderer timers never outlive them. */
export class ToolChatContainer extends Container {
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

/** Chat children that host tool presentation and share image display settings. */
export function isToolChatComponent(child: Component): child is ToolExecutionComponent | ToolGroupComponent {
	return child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent;
}

/** Append a tool row, folding consecutive rows that share a toolGroup into one group row. */
export function appendToolRow(chat: Container, component: ToolExecutionComponent, expanded: boolean): void {
	const toolGroup = component.toolGroup?.trim();
	const children = chat.children;
	const lastChild = children[children.length - 1];
	if (toolGroup && lastChild instanceof ToolGroupComponent && lastChild.toolGroup === toolGroup) {
		lastChild.addTool(component);
		return;
	}
	if (toolGroup && lastChild instanceof ToolExecutionComponent && lastChild.toolGroup?.trim() === toolGroup) {
		const group = new ToolGroupComponent(toolGroup, [lastChild, component]);
		group.setExpanded(expanded);
		children[children.length - 1] = group;
		return;
	}
	chat.addChild(component);
}

/** Detach hint for rows BackgroundService.detachForeground() can move: shell tools and subagents. */
export function toolDetachHint(keybindings: KeybindingsManager): ToolExecutionOptions["detachHint"] {
	return {
		isDetachable: (name) => name === "bash" || name === "powershell" || name === "subagent",
		keyLabel: () => keyLabel("app.backgroundTasks.detach", { keybindings }),
	};
}
