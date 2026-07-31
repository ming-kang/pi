/**
 * biu/render.ts — TUI rendering for the biu tool and the /biu kickoff message.
 *
 * Pi's fallback renderers dump full text and ignore `expanded`; the "get"
 * action returns a whole stage playbook, so both the tool result and the menu
 * kickoff message collapse to a one-line summary and expand on the standard
 * expand key.
 */
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	MessageRenderOptions,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { BiuKickoffDetails } from "./index.ts";
import { BIU_TOOL_LABEL, type BiuToolDetails, type BiuToolParams } from "./tool.ts";

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function firstText(result: AgentToolResult<BiuToolDetails>): string {
	for (const part of result.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

function describeCall(args: Partial<BiuToolParams>): string {
	switch (args.action) {
		case "spec":
			return ["spec", args.specStatus, args.title ? truncate(singleLine(args.title), 40) : undefined]
				.filter(Boolean)
				.join(" ");
		case "task":
			return ["task", args.op, args.id, args.status ? `-> ${args.status}` : undefined].filter(Boolean).join(" ");
		case "stage":
			return ["stage", args.to ? `-> ${args.to}` : undefined].filter(Boolean).join(" ");
		case "archive":
			return ["archive", args.shortname ? truncate(singleLine(args.shortname), 40) : undefined]
				.filter(Boolean)
				.join(" ");
		default:
			return args.action ?? "…";
	}
}

export function renderBiuCall(args: Partial<BiuToolParams>, theme: Theme): Component {
	const title = theme.fg("toolTitle", theme.bold(`${BIU_TOOL_LABEL} `));
	return new Text(`${title}${theme.fg("muted", describeCall(args))}`, 0, 0);
}

function markdownBlock(text: string): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
	return container;
}

function expandHint(theme: Theme): string {
	return `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

export function renderBiuResult(
	result: AgentToolResult<BiuToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, Partial<BiuToolParams>, BiuToolDetails>,
): Component {
	if (options.isPartial) return new Text(theme.fg("warning", "Updating Biu state..."), 0, 0);
	const text = firstText(result);
	if (context.isError) {
		return new Text(theme.fg("error", truncate(singleLine(text) || "Biu tool error", 200)), 0, 0);
	}
	if (!options.expanded) {
		const details = result.details;
		const summary =
			details?.action === "get"
				? `${details.statusLine} · snapshot and stage instructions loaded`
				: truncate(singleLine(text.split("\n")[0] ?? "") || (details?.statusLine ?? "done"), 160);
		return new Text(`${theme.fg("toolOutput", summary)}${expandHint(theme)}`, 0, 0);
	}
	return markdownBlock(text);
}

export function renderBiuKickoffMessage(
	message: CustomMessage<BiuKickoffDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	const content = typeof message.content === "string" ? message.content : "";
	const stage = message.details?.stage;
	const summary = `Biu · continue${stage ? ` ${stage}` : ""}`;
	if (!options.expanded) {
		return new Text(`${theme.fg("accent", theme.bold(summary))}${expandHint(theme)}`, options.outputPad, 0);
	}
	const container = new Container();
	container.addChild(new Text(theme.fg("accent", theme.bold(summary)), options.outputPad, 0));
	container.addChild(new Text(theme.fg("muted", content), options.outputPad, 0));
	return container;
}
