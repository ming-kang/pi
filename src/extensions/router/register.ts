/**
 * Apply router.json relays to Pi via registerProvider (config form + streamSimple).
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { ROUTER_API } from "./constants.ts";
import { toRegisterModel } from "./presets.ts";
import { streamRouterCodex } from "./stream.ts";
import type { RelayConfig, RouterFile } from "./types.ts";

/** Provider ids currently registered by this extension in the process. */
const registeredIds = new Set<string>();

export function getRegisteredRelayIds(): ReadonlySet<string> {
	return registeredIds;
}

export function toProviderConfig(relay: RelayConfig) {
	return {
		name: relay.id,
		baseUrl: relay.baseUrl.replace(/\/+$/, ""),
		apiKey: relay.apiKey,
		api: ROUTER_API,
		models: relay.models.map((model) => ({
			...toRegisterModel(model),
			api: ROUTER_API,
		})),
		streamSimple: streamRouterCodex,
	};
}

export function applyRouterFile(pi: ExtensionAPI, file: RouterFile): void {
	const nextIds = new Set(file.relays.map((relay) => relay.id));

	for (const id of [...registeredIds]) {
		if (!nextIds.has(id)) {
			try {
				pi.unregisterProvider(id);
			} catch {
				// Provider may already be gone after /reload.
			}
			registeredIds.delete(id);
		}
	}

	for (const relay of file.relays) {
		// Only register relays that have at least one model; empty catalog is not selectable.
		if (relay.models.length === 0) {
			if (registeredIds.has(relay.id)) {
				try {
					pi.unregisterProvider(relay.id);
				} catch {
					// ignore
				}
				registeredIds.delete(relay.id);
			}
			continue;
		}
		pi.registerProvider(relay.id, toProviderConfig(relay));
		registeredIds.add(relay.id);
	}
}

export function registerOneRelay(pi: ExtensionAPI, relay: RelayConfig): void {
	if (relay.models.length === 0) {
		if (registeredIds.has(relay.id)) {
			try {
				pi.unregisterProvider(relay.id);
			} catch {
				// ignore
			}
			registeredIds.delete(relay.id);
		}
		return;
	}
	pi.registerProvider(relay.id, toProviderConfig(relay));
	registeredIds.add(relay.id);
}

export function unregisterOneRelay(pi: ExtensionAPI, id: string): void {
	try {
		pi.unregisterProvider(id);
	} catch {
		// ignore
	}
	registeredIds.delete(id);
}
