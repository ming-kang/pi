import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

export const BACKGROUND_USAGE_TYPE = "background-usage";

export interface BackgroundUsageRecord {
	version: 1;
	taskId: string;
	usage: Usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsageValue(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate persisted ledger data and return only its serializable accounting fields. */
export function getBackgroundUsageRecord(entry: SessionEntry): BackgroundUsageRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== BACKGROUND_USAGE_TYPE) return undefined;
	const data = entry.data;
	if (!isRecord(data) || data.version !== 1 || typeof data.taskId !== "string" || !data.taskId.trim()) {
		return undefined;
	}
	const usage = data.usage;
	if (!isRecord(usage) || !isRecord(usage.cost)) return undefined;
	const { input, output, cacheRead, cacheWrite, totalTokens, reasoning, cacheWrite1h } = usage;
	const cost = usage.cost;
	if (
		!isUsageValue(input) ||
		!isUsageValue(output) ||
		!isUsageValue(cacheRead) ||
		!isUsageValue(cacheWrite) ||
		!isUsageValue(totalTokens) ||
		!isUsageValue(cost.input) ||
		!isUsageValue(cost.output) ||
		!isUsageValue(cost.cacheRead) ||
		!isUsageValue(cost.cacheWrite) ||
		!isUsageValue(cost.total) ||
		(reasoning !== undefined && !isUsageValue(reasoning)) ||
		(cacheWrite1h !== undefined && !isUsageValue(cacheWrite1h))
	)
		return undefined;
	return {
		version: 1,
		taskId: data.taskId,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			...(reasoning === undefined ? {} : { reasoning }),
			...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
			cost: {
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cacheRead,
				cacheWrite: cost.cacheWrite,
				total: cost.total,
			},
		},
	};
}

function* accountedUsageEntries(entries: readonly SessionEntry[]): Generator<{ key: string; usage: Usage }> {
	const backgroundTasks = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			yield {
				key: `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`,
				usage: entry.message.usage,
			};
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			yield { key: "Tools/summaries", usage: entry.message.usage };
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			yield { key: "Tools/summaries", usage: entry.usage };
		} else {
			const record = getBackgroundUsageRecord(entry);
			if (!record || backgroundTasks.has(record.taskId)) continue;
			backgroundTasks.add(record.taskId);
			yield { key: "Tools/summaries", usage: record.usage };
		}
	}
}

/** Legacy usage plus the first valid ledger record per task. Managed results omit usage. */
export function getAccountedUsages(entries: readonly SessionEntry[]): Usage[] {
	return Array.from(accountedUsageEntries(entries), ({ usage }) => usage);
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: readonly SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const { key, usage } of accountedUsageEntries(entries)) {
		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
