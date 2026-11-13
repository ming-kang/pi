/**
 * What a baseUrl must look like for each API tag, and where requests end up.
 *
 * pi-ai hands URL assembly to the vendor SDKs: OpenAI-style clients append
 * only the operation, so the version path belongs in baseUrl, while the
 * Anthropic and Mistral clients append `/v1/...` themselves.
 */

/** The path each client appends to baseUrl; APIs with other URL rules are absent. */
const REQUEST_PATHS: Readonly<Record<string, string>> = {
	"anthropic-messages": "/v1/messages",
	"openai-responses": "/responses",
	"openai-completions": "/chat/completions",
	"mistral-conversations": "/v1/chat/completions",
};

/** One-line guidance on the baseUrl shape an API tag expects, for while no baseUrl is set. */
function baseUrlHint(api: string | undefined): string | undefined {
	switch (api) {
		case "openai-responses":
		case "openai-completions":
		case "openai-codex-responses":
			return "baseUrl includes the version path, e.g. /v1";
		case "anthropic-messages":
			return "baseUrl is the bare origin; /v1/messages is appended";
		case "mistral-conversations":
			return "baseUrl is the bare origin; /v1 is appended";
		case "google-generative-ai":
			return "baseUrl includes the version path, e.g. /v1beta";
		default:
			return undefined;
	}
}

/** The empty baseUrl's placeholder, following the same convention as baseUrlHint. */
export function baseUrlPlaceholder(api: string | undefined): string {
	switch (api) {
		case "anthropic-messages":
		case "mistral-conversations":
			return "https://api.example.com";
		case "google-generative-ai":
			return "https://api.example.com/v1beta";
		default:
			return "https://api.example.com/v1";
	}
}

/** Shared baseUrl validation for provider-level and model-level entries; returns an error or undefined. */
export function validateBaseUrlValue(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "baseUrl must be a valid URL.";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `Unsupported protocol: ${url.protocol}`;
	}
	if (url.username || url.password || url.hash) {
		return "baseUrl must not contain credentials or a fragment.";
	}
	return undefined;
}

export interface ConnectionNote {
	text: string;
	/** The baseUrl most likely has the wrong shape for its API. */
	warning?: boolean;
}

/**
 * Where a request for this api and baseUrl is sent, so a wrong shape shows as
 * a wrong URL instead of a 404 at the first prompt. Model discovery tolerates
 * both shapes, which is why a fetched model list proves nothing about this.
 * Falls back to the generic shape hint while there is no URL to show.
 *
 * Only a doubled /v1 is called out: a missing version path is how DeepSeek and
 * GitHub Copilot really serve Chat Completions, so that shape is shown, not judged.
 */
export function connectionNote(api: string | undefined, baseUrl: string | undefined): ConnectionNote | undefined {
	const hint = baseUrlHint(api);
	const suffix = api ? REQUEST_PATHS[api] : undefined;
	// A query string would land in the middle of the joined URL; such a baseUrl keeps the generic hint.
	if (!suffix || !baseUrl || baseUrl.includes("?")) return hint ? { text: hint } : undefined;
	const base = baseUrl.replace(/\/+$/, "");
	const target = `Requests go to ${base}${suffix}`;
	return suffix.startsWith("/v1/") && /\/v1$/i.test(base)
		? { text: `${target} — /v1 is doubled; remove it from baseUrl.`, warning: true }
		: { text: target };
}
