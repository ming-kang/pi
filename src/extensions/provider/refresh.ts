/**
 * Runtime refresh coordination for /provider.
 *
 * Saves hit disk immediately; runtime refreshes are deferred: normal field
 * edits mark the provider as touched and flush when the session closes, while
 * Fetch Models refreshes the current provider right before auth resolution
 * and right after importing. Save failures and refresh failures are reported
 * separately so a successful write is never misreported.
 */

import type { ModelRuntime } from "../../core/model-runtime.ts";
import { formatError, REFRESH_TIMEOUT_MS } from "./constants.ts";

export interface RefreshOutcome {
	ok: boolean;
	aborted: boolean;
	errors: string[];
}

export class RefreshCoordinator {
	private readonly runtime: ModelRuntime;
	private readonly touched = new Set<string>();

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	touch(providerId: string): void {
		this.touched.add(providerId);
	}

	get touchedProviders(): readonly string[] {
		return [...this.touched];
	}

	/** Offline-scoped refresh of a single provider (fetch prep / post-import). */
	async refreshNow(providerId: string, signal?: AbortSignal): Promise<RefreshOutcome> {
		this.touched.delete(providerId);
		return this.run([providerId], signal);
	}

	/** Refresh everything touched, including deleted provider ids. */
	async flush(signal?: AbortSignal): Promise<RefreshOutcome> {
		const providers = [...this.touched];
		this.touched.clear();
		if (providers.length === 0) return { ok: true, aborted: false, errors: [] };
		return this.run(providers, signal);
	}

	private async run(providers: readonly string[], signal?: AbortSignal): Promise<RefreshOutcome> {
		const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
		const errors: string[] = [];
		try {
			const result = await this.runtime.refresh({ allowNetwork: false, providers, signal: combined });
			for (const [providerId, error] of result.errors) {
				errors.push(`${providerId}: ${formatError(error)}`);
			}
			const configError = this.runtime.getError();
			if (configError) errors.push(configError);
			return { ok: errors.length === 0, aborted: result.aborted, errors };
		} catch (error) {
			errors.push(formatError(error));
			return { ok: false, aborted: combined.aborted, errors };
		}
	}
}
