import {
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

const TOOL_CHROME_WIDTH = 2;
const FALLBACK_ARGS_WIDTH = 120;
const FALLBACK_RESULT_LINES = 10;

class ToolChromeComponent implements Component {
	private component: Component;
	private prefix: string;
	private trimLeadingBlankLines: boolean;

	constructor(component: Component, prefix: string, trimLeadingBlankLines = false) {
		this.component = component;
		this.prefix = prefix;
		this.trimLeadingBlankLines = trimLeadingBlankLines;
	}

	render(width: number): string[] {
		const renderedLines = this.component.render(Math.max(1, width - TOOL_CHROME_WIDTH));
		let start = 0;
		if (this.trimLeadingBlankLines) {
			while (renderedLines[start] === "") start++;
		}
		const lines = renderedLines.slice(start);
		if (lines.length === 0) return [];
		return lines.map((line, index) => {
			if (index === 0) return `${this.prefix}${line}`;
			return line ? `  ${line}` : "";
		});
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

class FallbackResultComponent implements Component {
	private output: string;
	private expanded: boolean;

	constructor(output: string, expanded: boolean) {
		this.output = output;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const styledOutput = theme.fg("toolOutput", this.output);
		if (this.expanded) return new Text(styledOutput, 0, 0).render(width);

		const preview = truncateToVisualLines(styledOutput, FALLBACK_RESULT_LINES, width);
		if (preview.skippedCount <= 0) return preview.visualLines;
		const hint =
			theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
			` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return [...preview.visualLines, truncateToWidth(hint, width, "...")];
	}

	invalidate(): void {}
}

function formatFallbackArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	const summary = entries
		.map(([key, value]) => {
			try {
				return `${key}=${JSON.stringify(value) ?? String(value)}`;
			} catch {
				return `${key}=${String(value)}`;
			}
		})
		.join(" ")
		.replace(/\s+/g, " ");
	return truncateToWidth(summary, FALLBACK_ARGS_WIDTH, "...");
}

export class ToolExecutionComponent extends Container {
	private contentContainer: Container;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	readonly toolGroup: string | undefined;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.toolGroup =
			this.getRenderShell() === "self"
				? undefined
				: (this.toolDefinition?.toolGroup ?? this.builtInToolDefinition?.toolGroup);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		this.selfRenderContainer = new Container();
		this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentContainer);

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined, toolGroupSummary = false): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			toolGroupSummary,
		};
	}

	private createCallFallback(): Component {
		const args = formatFallbackArgs(this.args);
		const suffix = args ? theme.fg("dim", `(${args})`) : "";
		return new Text(`${theme.fg("toolTitle", theme.bold(this.toolName))}${suffix}`, 0, 0);
	}

	private wrapCall(component: Component): Component {
		const color = this.isPartial ? "warning" : this.result?.isError ? "error" : "success";
		return new ToolChromeComponent(component, `${theme.fg(color, "●")} `);
	}

	private wrapResult(component: Component): Component {
		return new ToolChromeComponent(component, theme.fg("dim", "│ "), true);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new FallbackResultComponent(output, this.expanded);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	renderCallSummary(width: number): string[] {
		const callRenderer = this.getCallRenderer();
		let component: Component;
		if (!callRenderer) {
			component = this.createCallFallback();
		} else {
			try {
				component = callRenderer(this.args, theme, this.getRenderContext(undefined, true));
			} catch {
				component = this.createCallFallback();
			}
		}
		return this.wrapCall(component).render(width);
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		const selfRendered = this.getRenderShell() === "self";
		const renderContainer = selfRendered ? this.selfRenderContainer : this.contentContainer;
		renderContainer.clear();

		const addCall = (component: Component) => {
			renderContainer.addChild(selfRendered ? component : this.wrapCall(component));
			hasContent = true;
		};
		const addResult = (component: Component) => {
			renderContainer.addChild(selfRendered ? component : this.wrapResult(component));
			hasContent = true;
		};

		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			addCall(this.createCallFallback());
		} else {
			try {
				const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
				this.callRendererComponent = component;
				addCall(component);
			} catch {
				this.callRendererComponent = undefined;
				addCall(this.createCallFallback());
			}
		}

		if (this.result) {
			const resultRenderer = this.getResultRenderer();
			if (!resultRenderer) {
				const component = this.createResultFallback();
				if (component) addResult(component);
			} else {
				try {
					const component = resultRenderer(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.getRenderContext(this.resultRendererComponent),
					);
					this.resultRendererComponent = component;
					addResult(component);
				} catch {
					this.resultRendererComponent = undefined;
					const component = this.createResultFallback();
					if (component) addResult(component);
				}
			}
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (!hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}
}
