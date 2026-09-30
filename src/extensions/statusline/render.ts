import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsage } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { UsageSummary } from "./usage.ts";

export interface StatuslineData {
	model: Pick<Model<string>, "id" | "name" | "provider" | "reasoning" | "contextWindow"> | undefined;
	thinkingLevel: ThinkingLevel;
	cwd: string;
	home: string;
	gitBranch: string | null;
	contextUsage: ContextUsage | undefined;
	usage: UsageSummary;
	usesSubscription: boolean;
	statuses: ReadonlyMap<string, string>;
}

const CONTEXT_WARNING_PERCENT = 40;
const CONTEXT_ERROR_PERCENT = 80;
const MIN_GAP = 1;

/** Shorten a path to `~` relative to the user's home directory. */
function formatWorkingDirectory(cwd: string, home: string): string {
	const homeDirectory = home.replace(/[\\/]+$/, "");
	if (!homeDirectory) return cwd;
	const normalizePath = (filePath: string) => filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const normalizedHomeDirectory = normalizePath(homeDirectory);
	const normalizedCwd = normalizePath(cwd);
	if (normalizedCwd === normalizedHomeDirectory) return "~";
	if (normalizedCwd.startsWith(`${normalizedHomeDirectory}/`)) {
		return `~${cwd.slice(homeDirectory.length).replace(/\\/g, "/")}`;
	}
	return cwd;
}

/** Collapse a display path to `~/basename` or bare basename when tight. */
function pathBasename(displayPath: string): string {
	const normalized = displayPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalized || normalized === "~") return normalized || displayPath;
	const slash = normalized.lastIndexOf("/");
	if (slash < 0) return normalized;
	const base = normalized.slice(slash + 1);
	return normalized.startsWith("~/") ? `~/${base}` : base;
}

function formatTokenCount(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function joinSegments(segments: string[], separator: string): string {
	return segments.filter(Boolean).join(separator);
}

function formatContextUsage(data: StatuslineData, theme: Theme): string {
	const contextWindow = data.contextUsage?.contextWindow ?? data.model?.contextWindow;
	const suffix = contextWindow ? `/${formatTokenCount(contextWindow)}` : "";
	const percent = data.contextUsage?.percent;
	const label = `CTX ${percent == null ? "?" : percent.toFixed(1)}%${suffix}`;
	if (percent != null && percent > CONTEXT_ERROR_PERCENT) return theme.fg("error", label);
	if (percent != null && percent > CONTEXT_WARNING_PERCENT) return theme.fg("warning", label);
	return theme.fg("accent", label);
}

/** Format fields once, then offer full usage, without W, and without W/R. */
function formatUsageCandidates(summary: UsageSummary, subscription: boolean, theme: Theme): string[] {
	const tokens = [
		summary.input > 0 ? `↑${formatTokenCount(summary.input)}` : "",
		summary.output > 0 ? `↓${formatTokenCount(summary.output)}` : "",
	];
	const read = summary.cacheRead > 0 ? `R${formatTokenCount(summary.cacheRead)}` : "";
	const write = summary.cacheWrite > 0 ? `W${formatTokenCount(summary.cacheWrite)}` : "";
	const suffix = [
		summary.latestCacheHitPercent === undefined ? "" : `CH${summary.latestCacheHitPercent.toFixed(1)}%`,
		summary.cost > 0 ? `$${summary.cost.toFixed(3)}${subscription ? " (sub)" : ""}` : "",
	];
	const candidates = [[read, write], [read], []].map((cache) => joinSegments([...tokens, ...cache, ...suffix], " "));
	return [...new Set(candidates.filter(Boolean))].map((text) => theme.fg("dim", text));
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>, theme: Theme): string {
	return (
		[...statuses.entries()]
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([, text]) =>
				text
					.replace(/[\r\n\t]/g, " ")
					.replace(/ +/g, " ")
					.trim(),
			)
			.filter(Boolean)
			// Preserve colors supplied by other extensions.
			.map((text) => (text.includes("\x1b[") ? text : theme.fg("muted", text)))
			.join("  ")
	);
}

function fitsLeftRight(left: string, right: string, width: number): boolean {
	return visibleWidth(left) + visibleWidth(right) + (left && right ? MIN_GAP : 0) <= width;
}

/** Right-align the second cluster; when both compete, cap it at about 45%. */
function layoutLeftRight(left: string, right: string, width: number, ellipsis: string): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, ellipsis);
	let rightWidth = visibleWidth(right);
	if (!left) return `${" ".repeat(Math.max(0, width - rightWidth))}${truncateToWidth(right, width, ellipsis)}`;
	let leftWidth = visibleWidth(left);
	if (leftWidth + rightWidth + MIN_GAP > width) {
		const maxRightWidth = Math.min(rightWidth, Math.max(8, Math.floor(width * 0.45)));
		right = truncateToWidth(right, maxRightWidth, ellipsis);
		rightWidth = visibleWidth(right);
		const maxLeftWidth = width - rightWidth - MIN_GAP;
		if (maxLeftWidth < 1) return truncateToWidth(right, width, ellipsis);
		left = truncateToWidth(left, maxLeftWidth, ellipsis);
		leftWidth = visibleWidth(left);
	}
	return `${left}${" ".repeat(Math.max(MIN_GAP, width - leftWidth - rightWidth))}${right}`;
}

/** Center status absolutely when possible; otherwise balance the remaining gap. */
function layoutSecondaryLine(left: string, status: string, right: string, width: number, ellipsis: string): string {
	const leftWidth = visibleWidth(left);
	const statusWidth = visibleWidth(status);
	const rightWidth = visibleWidth(right);
	const free = width - leftWidth - statusWidth - rightWidth;
	if (!status || free < MIN_GAP * 2) return layoutLeftRight(left, right, width, ellipsis);
	let leftPad = Math.floor((width - statusWidth) / 2) - leftWidth;
	if (leftPad < MIN_GAP || free - leftPad < MIN_GAP) leftPad = Math.floor(free / 2);
	return `${left}${" ".repeat(leftPad)}${status}${" ".repeat(free - leftPad)}${right}`;
}

function renderPrimaryLine(data: StatuslineData, theme: Theme, width: number, ellipsis: string): string {
	const { model, thinkingLevel } = data;
	const name = theme.fg("toolTitle", theme.bold(model?.name ?? model?.id ?? "no-model"));
	const provider = model?.provider ? theme.fg("muted", `(${model.provider})`) : "";
	const effort =
		model?.reasoning && thinkingLevel !== "off" ? theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel) : "";
	const separator = theme.fg("dim", " · ");
	const rich = joinSegments([joinSegments([name, provider], " "), effort], separator);
	const plain = joinSegments([name, effort], separator);
	const cwd = formatWorkingDirectory(data.cwd, data.home);
	const full = theme.fg("success", cwd);
	const short = theme.fg("success", pathBasename(cwd));
	const branch = data.gitBranch ? theme.fg("accent", data.gitBranch) : "";
	// Shortening the path or removing the provider can make room for the branch again.
	const candidates = [
		{ left: rich, right: joinSegments([full, branch], separator) },
		{ left: rich, right: full },
		{ left: rich, right: joinSegments([short, branch], separator) },
		{ left: rich, right: short },
		{ left: plain, right: joinSegments([short, branch], separator) },
		{ left: plain, right: short },
		{ left: plain, right: "" },
	];
	const chosen = candidates.find(({ left, right }) => fitsLeftRight(left, right, width)) ?? {
		left: plain,
		right: short,
	};
	return layoutLeftRight(chosen.left, chosen.right, width, ellipsis);
}

/** Fixed two-line presentation, independent of session access and footer lifecycle. */
export function renderStatusline(data: StatuslineData, theme: Theme, width: number): string[] {
	const ellipsis = theme.fg("dim", "...");
	const primary = renderPrimaryLine(data, theme, width, ellipsis);
	const context = formatContextUsage(data, theme);
	const status = formatExtensionStatuses(data.statuses, theme);
	const candidates = formatUsageCandidates(data.usage, data.usesSubscription, theme);
	const usage = candidates.find((candidate) => fitsLeftRight(context, candidate, width));
	// If no usage variant fits, retain the original full-usage truncation policy.
	const secondary =
		candidates.length > 0 && usage === undefined
			? layoutLeftRight(context, candidates[0], width, ellipsis)
			: layoutSecondaryLine(context, status, usage ?? "", width, ellipsis);
	return [primary, secondary];
}
