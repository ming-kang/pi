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
import type { AgentToolResult, ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { collapsedLinesHint, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

interface ConvertedImage {
	sourceData: string;
	sourceMimeType: string;
	data: string;
	mimeType: string;
}

interface PendingImageConversion {
	sourceData: string;
	sourceMimeType: string;
}

const TOOL_CHROME_WIDTH = 2;
const FALLBACK_ARGS_WIDTH = 120;
const FALLBACK_RESULT_LINES = 10;
const PROGRESS_THRESHOLD_MS = 2000;
const DEFAULT_PROGRESS_REFRESH_INTERVAL_MS = 1000;
const MIN_RENDER_REFRESH_INTERVAL_MS = 250;
const MAX_RENDER_REFRESH_INTERVAL_MS = 60_000;

function normalizeRenderRefreshInterval(intervalMs: number | undefined): number | undefined {
	if (intervalMs === undefined || !Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
	return Math.min(MAX_RENDER_REFRESH_INTERVAL_MS, Math.max(MIN_RENDER_REFRESH_INTERVAL_MS, Math.round(intervalMs)));
}

function formatElapsed(ms: number): string {
	const roundedTenths = Math.round(ms / 100) / 10;
	if (roundedTenths < 60) return `${roundedTenths.toFixed(1)}s`;
	const roundedSeconds = Math.round(ms / 1000);
	return `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;
}

class ToolChromeComponent implements Component {
	private component: Component;
	private prefix: string;
	private continuationPrefix: string;
	private blankLinePrefix: string;
	private trimLeadingBlankLines: boolean;

	constructor(
		component: Component,
		prefix: string,
		options: { trimLeadingBlankLines?: boolean; continuationPrefix?: string; blankLinePrefix?: string } = {},
	) {
		this.component = component;
		this.prefix = prefix;
		this.continuationPrefix = options.continuationPrefix ?? "  ";
		this.blankLinePrefix = options.blankLinePrefix ?? "";
		this.trimLeadingBlankLines = options.trimLeadingBlankLines ?? false;
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
			return line ? `${this.continuationPrefix}${line}` : this.blankLinePrefix;
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
		const hint = collapsedLinesHint(theme, preview.skippedCount, "earlier");
		return [truncateToWidth(hint, width, "…"), ...preview.visualLines];
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
	private convertedImages = new Map<number, ConvertedImage>();
	private pendingImageConversions = new Map<number, PendingImageConversion>();
	private hideComponent = false;
	private progressStartedAt?: number;
	private refreshTimer?: NodeJS.Timeout;
	private disposed = false;

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

	private getRendersOwnProgress(): boolean {
		return this.toolDefinition?.rendersOwnProgress ?? this.builtInToolDefinition?.rendersOwnProgress ?? false;
	}

	private shouldRenderGenericProgress(): boolean {
		return !this.getRendersOwnProgress() && this.getRenderShell() !== "self";
	}

	private getExplicitRenderRefreshInterval(): number | undefined {
		const intervalMs =
			this.toolDefinition?.renderRefreshIntervalMs ?? this.builtInToolDefinition?.renderRefreshIntervalMs;
		return normalizeRenderRefreshInterval(intervalMs);
	}

	private getActiveRenderRefreshInterval(): number | undefined {
		const explicitInterval = this.getExplicitRenderRefreshInterval();
		if (!this.shouldRenderGenericProgress()) return explicitInterval;
		return explicitInterval === undefined
			? DEFAULT_PROGRESS_REFRESH_INTERVAL_MS
			: Math.min(DEFAULT_PROGRESS_REFRESH_INTERVAL_MS, explicitInterval);
	}

	private getRenderContext(lastComponent: Component | undefined, toolGroupSummary = false): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				if (this.disposed) return;
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
			result: this.result
				? {
						content: this.result.content as AgentToolResult<unknown>["content"],
						details: this.result.details,
					}
				: undefined,
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
		// Continuation lines share the result rail so the whole block reads as one
		// unit hanging off the dot instead of an indented island above a lone rail.
		const rail = theme.fg("dim", "│ ");
		return new ToolChromeComponent(component, `${theme.fg(color, "●")} `, {
			continuationPrefix: rail,
			blankLinePrefix: theme.fg("dim", "│"),
		});
	}

	private wrapResult(component: Component): Component {
		const rail = theme.fg("dim", "│ ");
		return new ToolChromeComponent(component, rail, {
			trimLeadingBlankLines: true,
			continuationPrefix: rail,
			blankLinePrefix: theme.fg("dim", "│"),
		});
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
		if (this.disposed) return;
		this.executionStarted = true;
		if (this.progressStartedAt === undefined && this.shouldRenderGenericProgress()) {
			this.progressStartedAt = Date.now();
		}
		if (this.refreshTimer === undefined) {
			const intervalMs = this.getActiveRenderRefreshInterval();
			if (intervalMs !== undefined) {
				this.refreshTimer = setInterval(() => {
					if (this.disposed || !this.isPartial) {
						this.clearRefreshTimer();
						return;
					}
					this.invalidate();
					this.ui.requestRender();
				}, intervalMs);
				this.refreshTimer.unref?.();
			}
		}
		this.updateDisplay();
		this.ui.requestRender();
	}

	private clearRefreshTimer(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
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
		if (!isPartial) this.clearRefreshTimer();
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((content) => content.type === "image");
		const sourceMatches = (
			image: { data?: string; mimeType?: string } | undefined,
			entry: PendingImageConversion | undefined,
		): boolean => image?.data === entry?.sourceData && image?.mimeType === entry?.sourceMimeType;
		for (const [index, converted] of this.convertedImages) {
			if (!sourceMatches(imageBlocks[index], converted)) this.convertedImages.delete(index);
		}
		for (const [index, pending] of this.pendingImageConversions) {
			if (!sourceMatches(imageBlocks[index], pending)) this.pendingImageConversions.delete(index);
		}

		for (let i = 0; i < imageBlocks.length; i++) {
			const image = imageBlocks[i];
			if (!image.data || !image.mimeType || image.mimeType === "image/png") continue;
			if (sourceMatches(image, this.convertedImages.get(i))) continue;
			if (sourceMatches(image, this.pendingImageConversions.get(i))) continue;

			const index = i;
			const sourceData = image.data;
			const sourceMimeType = image.mimeType;
			this.pendingImageConversions.set(index, { sourceData, sourceMimeType });
			void convertToPng(sourceData, sourceMimeType)
				.then((converted) => {
					const pending = this.pendingImageConversions.get(index);
					if (pending?.sourceData !== sourceData || pending.sourceMimeType !== sourceMimeType) return;
					this.pendingImageConversions.delete(index);
					if (this.disposed) return;
					const currentImage = this.result?.content.filter((content) => content.type === "image")[index];
					if (currentImage?.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;
					if (converted) {
						this.convertedImages.set(index, { sourceData, sourceMimeType, ...converted });
						this.updateDisplay();
						this.ui.requestRender();
					}
				})
				.catch(() => {
					const pending = this.pendingImageConversions.get(index);
					if (pending?.sourceData === sourceData && pending.sourceMimeType === sourceMimeType) {
						this.pendingImageConversions.delete(index);
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

		if (this.executionStarted && this.isPartial && this.progressStartedAt !== undefined) {
			const elapsedMs = Date.now() - this.progressStartedAt;
			if (elapsedMs >= PROGRESS_THRESHOLD_MS) {
				addResult(new Text(theme.fg("muted", `Running… (${formatElapsed(elapsedMs)})`), 0, 0));
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
					const imageData = converted?.sourceData === img.data ? converted.data : img.data;
					const imageMimeType = converted?.sourceMimeType === img.mimeType ? converted.mimeType : img.mimeType;
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearRefreshTimer();
		this.pendingImageConversions.clear();
	}
}
