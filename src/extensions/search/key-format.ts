const DEVIN_PREFIX = "devin-session-token";

export function isAcceptableApiKey(key: unknown): key is string {
	return typeof key === "string" && key.trim().length > 0;
}

export function looksTruncated(key: unknown): boolean {
	if (typeof key !== "string") return false;
	const k = key.trim();
	if (!k.startsWith(DEVIN_PREFIX)) return false;
	const dollar = k.indexOf("$");
	if (dollar === -1) return true; // the $<JWT> suffix is gone entirely
	return !k.slice(dollar + 1).startsWith("eyJ"); // $ kept but the JWT body is missing or garbled
}

export const TRUNCATED_KEY_HINT =
	"key looks truncated — the '$' in devin-session-token$<JWT> may have been eaten by shell/config " +
	"variable expansion. Single-quote the value (or escape the '$') and set it again.";
