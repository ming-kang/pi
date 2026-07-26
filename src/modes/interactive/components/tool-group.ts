import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

export class ToolGroupComponent implements Component {
	readonly toolGroup: string;
	private readonly tools: ToolExecutionComponent[] = [];
	private expanded = false;

	constructor(toolGroup: string, tools: ToolExecutionComponent[] = []) {
		this.toolGroup = toolGroup;
		for (const tool of tools) {
			this.addTool(tool);
		}
	}

	addTool(tool: ToolExecutionComponent): void {
		tool.setExpanded(this.expanded);
		this.tools.push(tool);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools) {
			tool.setExpanded(expanded);
		}
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) {
			tool.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) {
			tool.setImageWidthCells(width);
		}
	}

	invalidate(): void {
		for (const tool of this.tools) {
			tool.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.tools.length === 0) return [];

		const safeWidth = Math.max(1, width);
		if (this.expanded) {
			return this.tools.flatMap((tool) => tool.render(safeWidth));
		}

		return ["", ...this.renderCollapsed(safeWidth)];
	}

	private renderCollapsed(width: number): string[] {
		const lines = this.tools.flatMap((tool) =>
			tool.renderCallSummary(width).map((line) => line.replace(/[ \t]+$/g, "")),
		);
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i]!.trim().length > 0) {
				const hint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
				const hintWidth = visibleWidth(hint);
				lines[i] =
					hintWidth >= width
						? truncateToWidth(hint, width, "...")
						: truncateToWidth(lines[i], width - hintWidth, "...") + hint;
				break;
			}
		}
		return lines;
	}
}
