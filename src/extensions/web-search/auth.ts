/**
 * auth.ts — Credential discovery and engine mode resolution for web_search.
 */

import { getAgentDir } from "../../config.ts";
import { readStoredCredential } from "../../core/auth-storage.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { ResolvedSearchCredentials, SearchEngineType } from "./types.ts";

const MINIMAX_CN_HOST = "https://api.minimaxi.com";
const MINIMAX_GLOBAL_HOST = "https://api.minimax.io";

/**
 * Resolve MiniMax search credentials from auth.json and environment variables.
 */
function resolveMiniMaxCredential(modelRuntime?: ModelRuntime): { key?: string; host?: string } {
	// 1. Check auth.json via modelRuntime or direct read
	const cnCred =
		modelRuntime?.getProviderAuthStatus("minimax-cn") ||
		readStoredCredential("minimax-cn", `${getAgentDir()}/auth.json`);

	if (cnCred && "key" in cnCred && typeof cnCred.key === "string" && cnCred.key.trim()) {
		return { key: cnCred.key.trim(), host: MINIMAX_CN_HOST };
	}

	const globalCred =
		modelRuntime?.getProviderAuthStatus("minimax") || readStoredCredential("minimax", `${getAgentDir()}/auth.json`);

	if (globalCred && "key" in globalCred && typeof globalCred.key === "string" && globalCred.key.trim()) {
		return { key: globalCred.key.trim(), host: MINIMAX_GLOBAL_HOST };
	}

	// 2. Check environment variables
	const envCnKey = process.env.MINIMAX_CN_API_KEY?.trim();
	if (envCnKey) {
		return { key: envCnKey, host: MINIMAX_CN_HOST };
	}

	const envGlobalKey = process.env.MINIMAX_API_KEY?.trim();
	if (envGlobalKey) {
		const host = process.env.MINIMAX_API_HOST?.trim() || MINIMAX_GLOBAL_HOST;
		return { key: envGlobalKey, host };
	}

	return {};
}

/**
 * Resolve DeepSeek search credentials from auth.json and environment variables.
 */
function resolveDeepSeekCredential(modelRuntime?: ModelRuntime): { key?: string } {
	// 1. Check auth.json
	const dsCred =
		modelRuntime?.getProviderAuthStatus("deepseek") || readStoredCredential("deepseek", `${getAgentDir()}/auth.json`);

	if (dsCred && "key" in dsCred && typeof dsCred.key === "string" && dsCred.key.trim()) {
		return { key: dsCred.key.trim() };
	}

	// 2. Check environment variables
	const envDsKey = process.env.DEEPSEEK_API_KEY?.trim();
	if (envDsKey) {
		return { key: envDsKey };
	}

	return {};
}

/**
 * Discover and resolve current active search engine credentials and execution mode.
 */
export function resolveSearchCredentials(modelRuntime?: ModelRuntime): ResolvedSearchCredentials {
	const mm = resolveMiniMaxCredential(modelRuntime);
	const ds = resolveDeepSeekCredential(modelRuntime);

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
