export const COMMAND_NAME = "router";
export const COMMAND_DESCRIPTION = "Manage Codex-style API relays";

/** Custom api tag; routes to our streamSimple, not Pi built-in handlers. */
export const ROUTER_API = "router-codex" as const;

export const CONFIG_VERSION = 1 as const;

export const DEFAULTS = {
	contextWindow: 272_000,
	maxTokens: 128_000,
	probeTimeoutMs: 10_000,
	probeBodyBytes: 4 * 1024 * 1024,
	probeMaxModels: 2_000,
	originator: "codex",
} as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const NO_UI_WARNING = "/router requires an interactive UI.";

export function isValidRelayId(id: string): boolean {
	return Boolean(id) && !id.includes("/") && !/[\u0000-\u001f\u007f]/.test(id);
}

export function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
