/**
 * statusline — fixed two-line footer for Pi.
 *
 * Balanced left/right layout:
 *   Line 1: Model (provider) · effort          ~cwd · branch
 *   Line 2: CTX used/window                    ↑in ↓out R W CH $cost
 *
 * Extension statuses sit in the middle of line 2 when space permits.
 * Pi does not expose auto-compaction state to custom footer factories, so the
 * native `(auto)` marker cannot be reproduced without depending on private APIs.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_ERROR_PERCENT = 90;
const MIN_GAP = 1;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface UsageSummary {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	latestCacheHitPercent?: number;
	totalCost: number;
}

interface UsageFormatOptions {
	includeCacheRead: boolean;
	includeCacheWrite: boolean;
}

function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

/** Shorten a path to `~` relative to the user's home directory. */
function formatWorkingDirectory(cwd: string): string {
	const rawHomeDirectory = process.env.USERPROFILE || process.env.HOME || "";
	const homeDirectory = rawHomeDirectory.replace(/[\\/]+$/, "");
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
	if (normalized.startsWith("~/")) return `~/${base}`;
	return base;
}

/** Format token counts like Pi's native footer: 999, 1.2k, 34k, 1.0M. */
function formatTokenCount(tokenCount: number): string {
	if (tokenCount < 1000) return `${tokenCount}`;
	if (tokenCount < 10_000) return `${(tokenCount / 1000).toFixed(1)}k`;
	if (tokenCount < 1_000_000) return `${Math.round(tokenCount / 1000)}k`;
	if (tokenCount < 10_000_000) return `${(tokenCount / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokenCount / 1_000_000)}M`;
}

/** Flatten extension status text to a single printable line. */
function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function joinSegments(segments: string[], separator: string): string {
	return segments.filter((segment) => segment.length > 0).join(separator);
}

interface BranchStats {
	thinkingLevel: ThinkingLevel;
	usage: UsageSummary;
}

/**
 * One pass over the branch: latest thinking level + cumulative usage.
 * Cached across footer paints while leaf identity + usage fingerprint hold.
 */
function computeBranchStats(branchEntries: SessionEntry[]): BranchStats {
	let thinkingLevel: ThinkingLevel = "off";
	const usage: UsageSummary = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};

	for (const entry of branchEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel as ThinkingLevel;
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const assistantMessage = entry.message as AssistantMessage;
		const inputTokens = assistantMessage.usage?.input ?? 0;
		const outputTokens = assistantMessage.usage?.output ?? 0;
		const cacheReadTokens = assistantMessage.usage?.cacheRead ?? 0;
		const cacheWriteTokens = assistantMessage.usage?.cacheWrite ?? 0;

		usage.inputTokens += inputTokens;
		usage.outputTokens += outputTokens;
		usage.cacheReadTokens += cacheReadTokens;
		usage.cacheWriteTokens += cacheWriteTokens;
		usage.totalCost += assistantMessage.usage?.cost?.total ?? 0;

		const latestPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
		const latestRequestUsedCache = cacheReadTokens > 0 || cacheWriteTokens > 0;
		usage.latestCacheHitPercent =
			latestRequestUsedCache && latestPromptTokens > 0 ? (cacheReadTokens / latestPromptTokens) * 100 : undefined;
	}

	return { thinkingLevel, usage };
}

/**
 * Fingerprint the leaf so streaming usage updates invalidate even when the
 * SessionEntry object identity is reused in place.
 */
function leafUsageFingerprint(entry: SessionEntry | undefined): string {
	if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return "";
	const assistantMessage = entry.message as AssistantMessage;
	const usage = assistantMessage.usage;
	if (!usage) return "";
	return [
		usage.input ?? 0,
		usage.output ?? 0,
		usage.cacheRead ?? 0,
		usage.cacheWrite ?? 0,
		usage.cost?.total ?? 0,
	].join(":");
}

/** Cache keyed by branch length + leaf identity + usage fingerprint. */
interface BranchStatsCache {
	length: number;
	lastEntry: SessionEntry | undefined;
	leafUsage: string;
	stats: BranchStats;
}

function getBranchStats(branchEntries: SessionEntry[], cache: { current: BranchStatsCache | null }): BranchStats {
	const lastEntry = branchEntries.length > 0 ? branchEntries[branchEntries.length - 1] : undefined;
	const leafUsage = leafUsageFingerprint(lastEntry);
	const cached = cache.current;
	if (
		cached &&
		cached.length === branchEntries.length &&
		cached.lastEntry === lastEntry &&
		cached.leafUsage === leafUsage
	) {
		return cached.stats;
	}

	const stats = computeBranchStats(branchEntries);
	cache.current = { length: branchEntries.length, lastEntry, leafUsage, stats };
	return stats;
}

/** Avoid rebuilding the branch path (leaf→root walk) on every footer paint. */
interface BranchPathCache {
	leafId: string | null;
	entries: SessionEntry[];
}

function getBranchEntries(
	getLeafId: () => string | null,
	getBranch: () => SessionEntry[],
	cache: { current: BranchPathCache | null },
): SessionEntry[] {
	const leafId = getLeafId();
	const cached = cache.current;
	if (cached && cached.leafId === leafId) return cached.entries;
	const entries = getBranch();
	cache.current = { leafId, entries };
	return entries;
}

function formatContextUsage(ctx: ExtensionContext, theme: Theme): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
	const contextWindowSuffix = contextWindow ? `/${formatTokenCount(contextWindow)}` : "";
	if (contextUsage?.percent == null) {
		return theme.fg("accent", `CTX ?%${contextWindowSuffix}`);
	}

	const label = `CTX ${contextUsage.percent.toFixed(1)}%${contextWindowSuffix}`;
	if (contextUsage.percent > CONTEXT_ERROR_PERCENT) return theme.fg("error", label);
	if (contextUsage.percent > CONTEXT_WARNING_PERCENT) return theme.fg("warning", label);
	return theme.fg("accent", label);
}

function formatUsageSummary(
	summary: UsageSummary,
	usesSubscription: boolean,
	theme: Theme,
	options: UsageFormatOptions = { includeCacheRead: true, includeCacheWrite: true },
): string {
	const usageParts: string[] = [];
	if (summary.inputTokens > 0) usageParts.push(`↑${formatTokenCount(summary.inputTokens)}`);
	if (summary.outputTokens > 0) usageParts.push(`↓${formatTokenCount(summary.outputTokens)}`);
	if (options.includeCacheRead && summary.cacheReadTokens > 0) {
		usageParts.push(`R${formatTokenCount(summary.cacheReadTokens)}`);
	}
	if (options.includeCacheWrite && summary.cacheWriteTokens > 0) {
		usageParts.push(`W${formatTokenCount(summary.cacheWriteTokens)}`);
	}
	if (summary.latestCacheHitPercent !== undefined) {
		usageParts.push(`CH${summary.latestCacheHitPercent.toFixed(1)}%`);
	}
	if (summary.totalCost > 0) {
		usageParts.push(`$${summary.totalCost.toFixed(3)}${usesSubscription ? " (sub)" : ""}`);
	}
	if (usageParts.length === 0) return "";
	return theme.fg("dim", usageParts.join(" "));
}

/** True when the string already carries SGR color codes from an extension. */
function hasAnsiColor(text: string): boolean {
	return text.includes("\x1b[");
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>, theme: Theme): string {
	const parts = Array.from(statuses.entries())
		.sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
		.map(([, text]) => sanitizeStatus(text))
		.filter(Boolean)
		// Extensions may pre-color status text. Don't re-wrap those.
		.map((text) => (hasAnsiColor(text) ? text : theme.fg("muted", text)));
	return parts.join("  ");
}

/** Left-align `left`, right-align `right`, filling the gap with spaces. */
function layoutLeftRight(left: string, right: string, width: number, theme: Theme): string {
	const ellipsis = theme.fg("dim", "...");
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, ellipsis);
	if (!left) {
		const rightWidth = visibleWidth(right);
		if (rightWidth >= width) return truncateToWidth(right, width, ellipsis);
		return `${" ".repeat(width - rightWidth)}${right}`;
	}

	let leftText = left;
	let rightText = right;
	let leftWidth = visibleWidth(leftText);
	let rightWidth = visibleWidth(rightText);

	if (leftWidth + rightWidth + MIN_GAP > width) {
		// Prefer keeping the right side readable; give it up to ~45% when both compete.
		const maxRightWidth = Math.min(rightWidth, Math.max(8, Math.floor(width * 0.45)));
		if (rightWidth > maxRightWidth) {
			rightText = truncateToWidth(rightText, maxRightWidth, ellipsis);
			rightWidth = visibleWidth(rightText);
		}
		const maxLeftWidth = width - rightWidth - MIN_GAP;
		if (maxLeftWidth < 1) return truncateToWidth(rightText, width, ellipsis);
		leftText = truncateToWidth(leftText, maxLeftWidth, ellipsis);
		leftWidth = visibleWidth(leftText);
	}

	const gap = Math.max(MIN_GAP, width - leftWidth - rightWidth);
	return `${leftText}${" ".repeat(gap)}${rightText}`;
}

/**
 * Line 2 zones: CTX left, optional extension status in the middle gap, usage right.
 * Drops middle first when space is tight; caller should pass progressively smaller rights.
 */
function layoutSecondaryLine(
	contextText: string,
	statusText: string,
	usageText: string,
	width: number,
	theme: Theme,
): string {
	const ellipsis = theme.fg("dim", "...");
	if (!usageText && !statusText) return truncateToWidth(contextText, width, ellipsis);

	const rightText = usageText || statusText;
	const middleText = usageText && statusText ? statusText : "";

	if (!middleText) return layoutLeftRight(contextText, rightText, width, theme);

	const contextWidth = visibleWidth(contextText);
	const usageWidth = visibleWidth(usageText);
	const statusWidth = visibleWidth(statusText);
	const needed = contextWidth + usageWidth + statusWidth + MIN_GAP * 2;

	if (needed <= width) {
		const free = width - contextWidth - usageWidth - statusWidth;
		const leftPad = Math.floor(free / 2);
		const rightPad = free - leftPad;
		return `${contextText}${" ".repeat(leftPad)}${statusText}${" ".repeat(rightPad)}${usageText}`;
	}

	// Not enough room for a full middle status — keep CTX · usage, drop status.
	return layoutLeftRight(contextText, usageText, width, theme);
}

function fitsLeftRight(left: string, right: string, width: number): boolean {
	if (!right) return visibleWidth(left) <= width;
	if (!left) return visibleWidth(right) <= width;
	return visibleWidth(left) + visibleWidth(right) + MIN_GAP <= width;
}

/** Progressive drop: branch → short path → drop provider → truncate. */
function fitPrimaryLine(options: {
	modelWithProvider: string;
	modelName: string;
	effortPart: string;
	cwdFull: string;
	cwdShort: string;
	branchPart: string;
	separator: string;
	width: number;
	theme: Theme;
}): string {
	const { modelWithProvider, modelName, effortPart, cwdFull, cwdShort, branchPart, separator, width, theme } = options;

	const leftRich = joinSegments([modelWithProvider, effortPart], separator);
	const leftPlain = joinSegments([modelName, effortPart], separator);

	const candidates: Array<{ left: string; right: string }> = [
		{ left: leftRich, right: joinSegments([cwdFull, branchPart], separator) },
		{ left: leftRich, right: cwdFull },
		{ left: leftRich, right: joinSegments([cwdShort, branchPart], separator) },
		{ left: leftRich, right: cwdShort },
		{ left: leftPlain, right: joinSegments([cwdShort, branchPart], separator) },
		{ left: leftPlain, right: cwdShort },
		{ left: leftPlain, right: "" },
	];

	for (const candidate of candidates) {
		if (fitsLeftRight(candidate.left, candidate.right, width)) {
			return layoutLeftRight(candidate.left, candidate.right, width, theme);
		}
	}

	return layoutLeftRight(leftPlain, cwdShort, width, theme);
}

/** Progressive drop on the usage side: full → drop W → drop R; status fills middle when space allows. */
function fitSecondaryLine(options: {
	contextText: string;
	statusText: string;
	usageCandidates: string[];
	width: number;
	theme: Theme;
}): string {
	const { contextText, statusText, usageCandidates, width, theme } = options;

	if (usageCandidates.length === 0) {
		return layoutLeftRight(contextText, statusText, width, theme);
	}

	for (const usageText of usageCandidates) {
		if (fitsLeftRight(contextText, usageText, width)) {
			return layoutSecondaryLine(contextText, statusText, usageText, width, theme);
		}
	}

	const fallbackUsage = usageCandidates[0] ?? "";
	return layoutLeftRight(contextText, fallbackUsage, width, theme);
}

export default function statusline(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!isTui(ctx)) return;

		// Per-footer instance: branch path + stats cached across paints until the
		// leaf moves (or streaming usage on the leaf changes).
		const branchPathCache: { current: BranchPathCache | null } = { current: null };
		const branchStatsCache: { current: BranchStatsCache | null } = { current: null };

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeFromBranchChanges = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribeFromBranchChanges,
				invalidate() {
					branchPathCache.current = null;
					branchStatsCache.current = null;
				},
				render(width: number): string[] {
					const branchEntries = getBranchEntries(
						() => ctx.sessionManager.getLeafId(),
						() => ctx.sessionManager.getBranch(),
						branchPathCache,
					);
					const { thinkingLevel, usage: usageSummary } = getBranchStats(branchEntries, branchStatsCache);
					const model = ctx.model;
					const modelName = theme.fg("toolTitle", theme.bold(model?.name ?? model?.id ?? "no-model"));
					const providerPart = model?.provider ? theme.fg("muted", `(${model.provider})`) : "";
					const modelWithProvider = providerPart ? `${modelName} ${providerPart}` : modelName;

					let effortPart = "";
					if (model?.reasoning && thinkingLevel !== "off") {
						effortPart = theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel);
					}

					const separator = theme.fg("dim", " · ");
					const cwdDisplay = formatWorkingDirectory(ctx.cwd);
					const cwdFull = theme.fg("success", cwdDisplay);
					const cwdShort = theme.fg("success", pathBasename(cwdDisplay));
					const gitBranch = footerData.getGitBranch();
					const branchPart = gitBranch ? theme.fg("accent", gitBranch) : "";

					const primaryLine = fitPrimaryLine({
						modelWithProvider,
						modelName,
						effortPart,
						cwdFull,
						cwdShort,
						branchPart,
						separator,
						width,
						theme,
					});

					const contextText = formatContextUsage(ctx, theme);
					const usesSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
					const usageCandidates = [
						formatUsageSummary(usageSummary, usesSubscription, theme, {
							includeCacheRead: true,
							includeCacheWrite: true,
						}),
						formatUsageSummary(usageSummary, usesSubscription, theme, {
							includeCacheRead: true,
							includeCacheWrite: false,
						}),
						formatUsageSummary(usageSummary, usesSubscription, theme, {
							includeCacheRead: false,
							includeCacheWrite: false,
						}),
					];
					// Deduplicate identical progressive candidates (e.g. when W/R are zero).
					const uniqueUsageCandidates = [...new Set(usageCandidates.filter(Boolean))];
					const statusText = formatExtensionStatuses(footerData.getExtensionStatuses(), theme);

					const secondaryLine = fitSecondaryLine({
						contextText,
						statusText,
						usageCandidates: uniqueUsageCandidates,
						width,
						theme,
					});

					return [primaryLine, secondaryLine];
				},
			};
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (isTui(ctx)) ctx.ui.setFooter(undefined);
	});
}
