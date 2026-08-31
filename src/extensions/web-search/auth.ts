/**
 * auth.ts — Credential discovery for web_search, plus the engine label derived from it.
 */

import { getAuthPath } from "../../config.ts";
import { readStoredCredential } from "../../core/auth-storage.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { isCommandConfigValue, resolveConfigValue } from "../../core/resolve-config-value.ts";
import type { MiniMaxSearchCredential, ResolvedSearchCredentials, SearchEngineType } from "./types.ts";

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
 * Resolve one provider's API key. The runtime chain already covers auth.json,
 * models.json, and environment variables; the direct file/env read is the
 * fallback for contexts without a ModelRuntime (or a provider it doesn't know).
 */
async function resolveProviderKey(
	modelRuntime: ModelRuntime | undefined,
	authPath: string,
	providerId: string,
	envVar: string,
): Promise<string | undefined> {
	return (
		(await runtimeApiKey(modelRuntime, providerId)) ??
		storedApiKey(providerId, authPath) ??
		trimValue(process.env[envVar])
	);
}

/**
 * Resolve MiniMax search credentials, preferring the CN account over global.
 */
async function resolveMiniMaxCredential(
	modelRuntime: ModelRuntime | undefined,
	authPath: string,
): Promise<MiniMaxSearchCredential | undefined> {
	const cnKey = await resolveProviderKey(modelRuntime, authPath, "minimax-cn", "MINIMAX_CN_API_KEY");
	if (cnKey) return { key: cnKey, host: MINIMAX_CN_HOST };

	const globalKey = await resolveProviderKey(modelRuntime, authPath, "minimax", "MINIMAX_API_KEY");
	if (globalKey) return { key: globalKey, host: trimValue(process.env.MINIMAX_API_HOST) ?? MINIMAX_GLOBAL_HOST };

	return undefined;
}

/**
 * Resolve DeepSeek search credentials.
 */
async function resolveDeepSeekCredential(
	modelRuntime: ModelRuntime | undefined,
	authPath: string,
): Promise<{ key: string } | undefined> {
	const key = await resolveProviderKey(modelRuntime, authPath, "deepseek", "DEEPSEEK_API_KEY");
	return key ? { key } : undefined;
}

/** The engine set implied by the configured credentials. */
export function configuredEngine(credentials: ResolvedSearchCredentials): SearchEngineType {
	if (credentials.minimax && credentials.deepseek) return "dual";
	if (credentials.minimax) return "minimax";
	if (credentials.deepseek) return "deepseek";
	return "none";
}

/**
 * Discover and resolve current active search engine credentials.
 */
export async function resolveSearchCredentials(
	modelRuntime?: ModelRuntime,
	authPath: string = getAuthPath(),
): Promise<ResolvedSearchCredentials> {
	const [minimax, deepseek] = await Promise.all([
		resolveMiniMaxCredential(modelRuntime, authPath),
		resolveDeepSeekCredential(modelRuntime, authPath),
	]);
	return { minimax, deepseek };
}
