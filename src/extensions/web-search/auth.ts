/**
 * auth.ts — Credential discovery and engine mode resolution for web_search.
 */

import { getAuthPath } from "../../config.ts";
import { readStoredCredential } from "../../core/auth-storage.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { isCommandConfigValue, resolveConfigValue } from "../../core/resolve-config-value.ts";
import type { ResolvedSearchCredentials, SearchEngineType } from "./types.ts";

const MINIMAX_CN_HOST = "https://api.minimaxi.com";
const MINIMAX_GLOBAL_HOST = "https://api.minimax.io";

function trimValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

/**
 * Resolve a provider API key through the runtime's canonical auth chain
 * (runtime key → auth.json → models.json → environment). Returns undefined
 * when the provider is unknown to the runtime or nothing is configured.
 */
async function runtimeApiKey(modelRuntime: ModelRuntime | undefined, providerId: string): Promise<string | undefined> {
	if (!modelRuntime) return undefined;
	try {
		return trimValue((await modelRuntime.getAuth(providerId))?.auth.apiKey);
	} catch {
		return undefined;
	}
}

/**
 * Direct auth.json read for contexts without a ModelRuntime. Resolves
 * command-configured keys (e.g. "!op read ...") like AuthStorage does.
 */
function storedApiKey(providerId: string, authPath: string): string | undefined {
	const credential = readStoredCredential(providerId, authPath);
	if (!credential || credential.type !== "api_key" || typeof credential.key !== "string") return undefined;
	const key = isCommandConfigValue(credential.key)
		? resolveConfigValue(credential.key, credential.env)
		: credential.key;
	return trimValue(key);
}

/**
 * Resolve MiniMax search credentials, preferring the CN account over global.
 */
async function resolveMiniMaxCredential(
	modelRuntime: ModelRuntime | undefined,
	authPath: string,
): Promise<{ key?: string; host?: string }> {
	const cnKey =
		(await runtimeApiKey(modelRuntime, "minimax-cn")) ??
		storedApiKey("minimax-cn", authPath) ??
		trimValue(process.env.MINIMAX_CN_API_KEY);
	if (cnKey) {
		return { key: cnKey, host: MINIMAX_CN_HOST };
	}

	const globalKey =
		(await runtimeApiKey(modelRuntime, "minimax")) ??
		storedApiKey("minimax", authPath) ??
		trimValue(process.env.MINIMAX_API_KEY);
	if (globalKey) {
		return { key: globalKey, host: trimValue(process.env.MINIMAX_API_HOST) ?? MINIMAX_GLOBAL_HOST };
	}

	return {};
}

/**
 * Resolve DeepSeek search credentials from auth.json and environment variables.
 */
async function resolveDeepSeekCredential(
	modelRuntime: ModelRuntime | undefined,
	authPath: string,
): Promise<{ key?: string }> {
	const key =
		(await runtimeApiKey(modelRuntime, "deepseek")) ??
		storedApiKey("deepseek", authPath) ??
		trimValue(process.env.DEEPSEEK_API_KEY);
	return key ? { key } : {};
}

/**
 * Discover and resolve current active search engine credentials and execution mode.
 */
export async function resolveSearchCredentials(
	modelRuntime?: ModelRuntime,
	authPath: string = getAuthPath(),
): Promise<ResolvedSearchCredentials> {
	const [mm, ds] = await Promise.all([
		resolveMiniMaxCredential(modelRuntime, authPath),
		resolveDeepSeekCredential(modelRuntime, authPath),
	]);

	let mode: SearchEngineType = "none";
	if (mm.key && ds.key) {
		mode = "dual";
	} else if (mm.key) {
		mode = "minimax";
	} else if (ds.key) {
		mode = "deepseek";
	}

	return {
		minimaxKey: mm.key,
		minimaxHost: mm.host,
		deepseekKey: ds.key,
		mode,
	};
}
