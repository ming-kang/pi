import type { Api, Model, ModelsSimpleStreamOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Resolve application defaults once, before authentication or network work begins. */
export function resolveModelStreamOptions(
	model: Model<Api>,
	settings: SettingsManager,
	runner: ExtensionRunner | undefined,
	options: SimpleStreamOptions = {},
): ModelsSimpleStreamOptions {
	const retry = settings.getProviderRetrySettings();
	const idleTimeout = settings.getHttpIdleTimeoutMs();
	const attribution = mergeProviderAttributionHeaders(model, settings, options.sessionId);
	return {
		...options,
		// Provider SDKs interpret zero as an immediate timeout, not an unlimited one.
		timeoutMs: options.timeoutMs ?? retry.timeoutMs ?? (idleTimeout === 0 ? 2147483647 : idleTimeout),
		websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settings.getWebSocketConnectTimeoutMs(),
		maxRetries: options.maxRetries ?? retry.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs ?? retry.maxRetryDelayMs,
		transformHeaders: async (requestHeaders) => {
			const headers = { ...attribution, ...requestHeaders };
			return runner?.hasHandlers("before_provider_headers") ? runner.emitBeforeProviderHeaders(headers) : headers;
		},
	};
}
