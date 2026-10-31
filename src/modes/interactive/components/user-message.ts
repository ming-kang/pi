import { Container, Markdown, type MarkdownTheme, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Gutter glyph before the first row. Same width as the fullscreen sticky prompt's `↑`, so their text columns align. */
const PROMPT_MARKER = "❯";
const GUTTER_WIDTH = 2;

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private readonly navigationAnchorOffsets = new Map<number, number>();
	private markdown!: Markdown;
	private rendered:
		| { readonly width: number; readonly source: readonly string[]; readonly lines: string[] }
		| undefined;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	getNavigationSummary(): string {
		return this.text.replaceAll(/\s+/g, " ").trim();
	}

	/** First visible text row within this component, after any leading blank lines. */
	getNavigationAnchorOffset(width: number): number {
		const cached = this.navigationAnchorOffsets.get(width);
		if (cached !== undefined) return cached;
		const offset = this.render(width).findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		const anchorOffset = offset < 0 ? 0 : offset;
		this.navigationAnchorOffsets.set(width, anchorOffset);
		return anchorOffset;
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.navigationAnchorOffsets.clear();
		this.rendered = undefined;
	}

	/** User messages take no mouse input; skip Container's per-event measurement, which renders at the wrong width. */
	override handleMouse(): undefined {
		return undefined;
	}

	private rebuild(): void {
		this.navigationAnchorOffsets.clear();
		this.rendered = undefined;
		this.clear();
		// The Markdown colors its own background; render() adds the gutter and side padding. No vertical padding: the
		// fullscreen sticky prompt replaces the first text row in place, so a padded block would leave a stray background
		// row beside the pinned summary.
		this.markdown = new Markdown(
			this.text,
			0,
			0,
			this.markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
				bgColor: (content: string) => theme.bg("userMessageBg", content),
			},
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				transform: createMarkdownTransform("user", false, this.markdownTransformers),
			},
		);
		this.addChild(this.markdown);
	}

	override render(width: number): string[] {
		const padding = Math.max(0, Math.floor(this.outputPad));
		const source = this.markdown.render(Math.max(1, width - padding * 2 - GUTTER_WIDTH));
		if (this.rendered?.width === width && this.rendered.source === source) return this.rendered.lines;
		if (source.length === 0) return [];

		const fill = (text: string) => theme.bg("userMessageBg", text);
		const indent = " ".repeat(padding);
		const marker = fill(`${indent}${theme.fg("muted", PROMPT_MARKER)} `);
		const hanging = fill(" ".repeat(padding + GUTTER_WIDTH));
		const trailing = padding > 0 ? fill(indent) : "";
		const lines = source.map((line, index) => `${index === 0 ? marker : hanging}${line}${trailing}`);

		// Markers stay at line starts. Prefix the end markers first so a single-row message still begins with the prompt
		// start marker that terminal and alt-screen prompt navigation look for.
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		lines[0] = OSC133_ZONE_START + lines[0];
		this.rendered = { width, source, lines };
		return lines;
	}
}
