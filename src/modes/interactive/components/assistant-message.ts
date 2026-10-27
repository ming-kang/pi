import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const SETTLED_THINKING_LABEL = "Thoughts";
const THINKING_PREVIEW_LINES = 3;
const THINKING_PREVIEW_INDENT = 2;

export const DEFAULT_ACTIVE_THINKING_LABEL = "Thinking...";

type ThinkingView = "expanded" | "active" | "settled";

function isVisibleAssistantBlock(block: AssistantMessage["content"][number]): boolean {
	return (
		(block.type === "text" && block.text.trim().length > 0) ||
		(block.type === "thinking" && block.thinking.trim().length > 0)
	);
}

function styleThinkingText(text: string): string {
	return theme.italic(theme.fg("thinkingText", text));
}

function createThinkingLabel(label: string, outputPad: number): Text {
	return new Text(styleThinkingText(label), outputPad, 0);
}

/** Shows the last three fully wrapped and padded lines of active thinking. */
class ThinkingRollingPreview implements Component {
	private readonly body: Text;

	constructor(text: string, paddingX: number) {
		this.body = new Text(styleThinkingText(text), paddingX, 0);
	}

	invalidate(): void {
		this.body.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.body.render(width).slice(-THINKING_PREVIEW_LINES);
	}
}

interface ThinkingComponentOptions {
	view: ThinkingView;
	text: string;
	activeLabel: string;
	outputPad: number;
	markdownTheme: MarkdownTheme;
	isStreaming: boolean;
	markdownTransformers: readonly MarkdownTransformer[];
}

function createThinkingComponent(options: ThinkingComponentOptions): Component {
	if (options.view === "active") {
		const container = new Container();
		container.addChild(createThinkingLabel(options.activeLabel, options.outputPad));
		container.addChild(new ThinkingRollingPreview(options.text, options.outputPad + THINKING_PREVIEW_INDENT));
		return container;
	}

	if (options.view === "settled") {
		return createThinkingLabel(SETTLED_THINKING_LABEL, options.outputPad);
	}

	return new Markdown(
		options.text,
		options.outputPad,
		0,
		options.markdownTheme,
		{
			color: (text: string) => theme.fg("thinkingText", text),
			italic: true,
		},
		{
			transform: createMarkdownTransform("assistant-thinking", options.isStreaming, options.markdownTransformers),
		},
	);
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private activeThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		activeThinkingLabel = DEFAULT_ACTIVE_THINKING_LABEL,
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.activeThinkingLabel = activeThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.activeThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(isVisibleAssistantBlock);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// After i--, i points at the last block in this thinking run.
				const remaining = message.content.slice(i + 1);
				const hasVisibleContentAfter = remaining.some(isVisibleAssistantBlock);
				const hasToolCallAfter = remaining.some((block) => block.type === "toolCall");
				const isActiveThinking = this.isStreaming && !hasVisibleContentAfter && !hasToolCallAfter;

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const view: ThinkingView = !hidden ? "expanded" : isActiveThinking ? "active" : "settled";
				const thinkingComponent = createThinkingComponent({
					view,
					text: thinkingBlocks.join("\n\n"),
					activeLabel: this.activeThinkingLabel,
					outputPad: this.outputPad,
					markdownTheme: this.markdownTheme,
					isStreaming: this.isStreaming,
					markdownTransformers: this.markdownTransformers,
				});
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
