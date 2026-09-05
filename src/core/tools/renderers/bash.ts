/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { type Component, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "../../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails, ShellToolConfig } from "../bash.ts";
import { collapsedLinesHint, getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;
export const BASH_UPDATE_THROTTLE_MS = 100;
type BashCachedRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};
class BashCallRenderComponent implements Component {
	private command: string | null = "";
	private timeout: number | undefined;
	private expanded = false;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private readonly config: Pick<ShellToolConfig, "name" | "prompt">;

	constructor(config: Pick<ShellToolConfig, "name" | "prompt">) {
		this.config = config;
	}

	update(args: { command?: string; timeout?: number } | undefined, expanded: boolean): void {
		const command = str(args?.command);
		const timeout = args?.timeout as number | undefined;
		if (this.command === command && this.timeout === timeout && this.expanded === expanded) {
			return;
		}

		this.command = command;
		this.timeout = timeout;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			this.cachedLines = this.renderLines(Math.max(1, width));
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderLines(width: number): string[] {
		const fullCall = formatFullShellCall(this.command, this.timeout, this.config);
		const fullLines = new Text(fullCall, 0, 0).render(width);
		if (this.expanded || fullLines.length <= 1) return fullLines;
		return [formatTruncatedShellCall(this.command, this.timeout, width, this.config)];
	}
}
class BashResultRenderComponent extends Container {
	state: BashCachedRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}
function formatShellPrompt(prompt: string): string {
	return theme.fg("toolTitle", theme.bold(`${prompt} `));
}
function formatShellTimeout(timeout: number | undefined): string {
	return timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
}
function styleShellCommand(command: string, config: Pick<ShellToolConfig, "name" | "prompt">): string {
	const language = config.name === "powershell" ? "powershell" : "bash";
	return highlightCode(command, language).join("\n");
}
function formatFullShellCall(
	command: string | null,
	timeout: number | undefined,
	config: Pick<ShellToolConfig, "name" | "prompt">,
): string {
	const commandDisplay =
		command === null
			? invalidArgText(theme)
			: command
				? styleShellCommand(command, config)
				: theme.fg("toolOutput", "...");
	return formatShellPrompt(config.prompt) + commandDisplay + formatShellTimeout(timeout);
}
function fitCollapsedShellCall(
	body: string,
	timeout: number | undefined,
	width: number,
	suffix: string,
	config: Pick<ShellToolConfig, "name" | "prompt">,
): string {
	const prompt = formatShellPrompt(config.prompt);
	const timeoutSuffix = formatShellTimeout(timeout);
	const bodyWidth = Math.max(0, width - visibleWidth(prompt) - visibleWidth(suffix) - visibleWidth(timeoutSuffix));
	const fittedBody = truncateToWidth(body, bodyWidth, "");
	return truncateToWidth(prompt + fittedBody + suffix + timeoutSuffix, width, "…");
}
function formatTruncatedShellCall(
	command: string | null,
	timeout: number | undefined,
	width: number,
	config: Pick<ShellToolConfig, "name" | "prompt">,
): string {
	if (command === null) return truncateToWidth(formatFullShellCall(command, timeout, config), width, "…");
	if (!command) return formatFullShellCall(command, timeout, config);
	const physicalLines = command.split(/\r?\n/).filter((line) => line.trim());
	const firstNonEmptyLine = physicalLines[0]?.trim() ?? command.trim();
	const hiddenLines = Math.max(0, physicalLines.length - 1);
	const suffix =
		hiddenLines > 0
			? theme.fg("muted", ` (+${hiddenLines} line${hiddenLines === 1 ? "" : "s"})`)
			: theme.fg("muted", " …");
	return fitCollapsedShellCall(styleShellCommand(firstNonEmptyLine, config), timeout, width, suffix, config);
}
function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
): void {
	const state = component.state;
	component.clear();

	const background = result.details?.background;
	let output =
		background?.kind === "background"
			? `Moved to background · ${background.taskId}`
			: getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint = collapsedLinesHint(theme, state.cachedSkipped, "earlier");
						return ["", truncateToWidth(hint, width, "…"), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
}

/** Shell renderers are shared by bash and powershell, which differ in the prompt and highlight language. */
export function createShellRenderers(
	config: Pick<ShellToolConfig, "name" | "prompt">,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			const component =
				(context.lastComponent as BashCallRenderComponent | undefined) ?? new BashCallRenderComponent(config);
			component.update(args as { command?: string; timeout?: number } | undefined, context.expanded);
			return component;
		},
		renderResult(result, options, _theme, context) {
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages);
			component.invalidate();
			return component;
		},
	};
}
