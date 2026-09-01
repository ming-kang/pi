/**
 * Apply router.json relays to Pi via registerProvider (config form + streamSimple).
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { ROUTER_API } from "./constants.ts";
import { toRegisterModel } from "./presets.ts";
import { streamRouterCodex } from "./stream.ts";
import type { RelayConfig, RouterFile } from "./types.ts";

/** Provider ids registered by this extension, isolated to each SDK host. */
const registeredIdsByApi = new WeakMap<ExtensionAPI, Set<string>>();

function registeredIdsFor(pi: ExtensionAPI): Set<string> {
	let ids = registeredIdsByApi.get(pi);
	if (!ids) {
		ids = new Set<string>();
		registeredIdsByApi.set(pi, ids);
	}
	return ids;
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
	const registeredIds = registeredIdsFor(pi);
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
					// Ignore stale registrations after /reload.
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
	const registeredIds = registeredIdsFor(pi);
	if (relay.models.length === 0) {
		if (registeredIds.has(relay.id)) {
			try {
				pi.unregisterProvider(relay.id);
			} catch {
				// Ignore stale registrations after /reload.
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
		// Ignore stale registrations after /reload.
	}
	registeredIdsFor(pi).delete(id);
}
