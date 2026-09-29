import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { createAllToolRenderers } from "../../../core/tools/renderers/index.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { type Theme, theme } from "../theme/theme.ts";
import { createCallFallback, FallbackResultComponent } from "./fallback.ts";
import { FramedComponent, type ToolStatus, toolMarkerColor, toolStatus, toolStyle } from "./style.ts";

/**
 * What this component needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a definition and a bare renderer pair are equally acceptable.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}

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

let builtInRenderers: ReturnType<typeof createAllToolRenderers> | undefined;

/**
 * One tool call in the transcript: a marker line for the call and a rail for its result.
 * `style.ts` owns how that looks; this class owns the call's lifecycle.
 */
export class ToolExecutionComponent extends Container {
	private gap: Spacer;
	private contentContainer: Container;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
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
	private toolDefinition?: ToolRenderers;
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
	private disposed = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.gap = new Spacer(toolStyle.gap.afterOther);
		this.addChild(this.gap);

		this.contentContainer = new Container();
		this.selfRenderContainer = new Container();
		this.addChild(this.isSelfRendered() ? this.selfRenderContainer : this.contentContainer);

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private isSelfRendered(): boolean {
		return this.toolDefinition?.renderShell === "self";
	}

	private status(): ToolStatus {
		return toolStatus({ isPartial: this.isPartial, isError: this.result?.isError ?? false });
	}

	/** Blank lines above this row; the chat sets it from what precedes the row. */
	setLeadingGap(lines: number): void {
		this.gap.setLines(lines);
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
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
		};
	}

	private frame(component: Component, kind: "header" | "body"): Component {
		return new FramedComponent(component, kind, () => toolMarkerColor(this.status()));
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new FallbackResultComponent(output, this.expanded);
	}

	/**
	 * A successful result of an explore tool stays hidden until expanded; a failure always shows.
	 * Only the built-in result renderer is folded, so an extension that overrides the tool with its
	 * own renderResult keeps control of what its row shows.
	 */
	private hidesCollapsedResult(): boolean {
		if (this.expanded || this.result?.isError || !toolStyle.collapsed.headerOnly.has(this.toolName)) return false;
		builtInRenderers ??= createAllToolRenderers();
		const builtIn = (builtInRenderers as Record<string, ToolRenderers>)[this.toolName];
		return builtIn?.renderResult !== undefined && builtIn.renderResult === this.getResultRenderer();
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		if (this.disposed) return;
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

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.isSelfRendered()) {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
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

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.isSelfRendered()) return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
		});
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		const selfRendered = this.isSelfRendered();
		const renderContainer = selfRendered ? this.selfRenderContainer : this.contentContainer;
		renderContainer.clear();

		const addCall = (component: Component) => {
			renderContainer.addChild(selfRendered ? component : this.createResultRegion(this.frame(component, "header")));
			hasContent = true;
		};
		const addResult = (component: Component) => {
			renderContainer.addChild(selfRendered ? component : this.createResultRegion(this.frame(component, "body")));
			hasContent = true;
		};

		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			addCall(createCallFallback(this.toolName, this.args));
		} else {
			try {
				const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
				this.callRendererComponent = component;
				addCall(component);
			} catch {
				this.callRendererComponent = undefined;
				addCall(createCallFallback(this.toolName, this.args));
			}
		}

		if (this.result && (selfRendered || !this.hidesCollapsedResult())) {
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
					const cached = this.convertedImages.get(i);
					const converted =
						cached?.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		(this.rendererState as { dispose?: () => void }).dispose?.();
		this.pendingImageConversions.clear();
	}
}
