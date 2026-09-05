/** Apply router.json using provider-scoped public Responses stream wrappers. */
import type { ExtensionAPI, ProviderConfig } from "../../core/extensions/types.ts";
import { ROUTER_API } from "./constants.ts";
import { toRegisterModel } from "./presets.ts";
import { loadRouterInstallationId, RouterRequestState } from "./state.ts";
import { streamRouterCodex } from "./stream.ts";
import type { RelayConfig, RouterFile } from "./types.ts";

const registeredIdsByApi = new WeakMap<ExtensionAPI, Set<string>>();
const requestStates = new WeakMap<ExtensionAPI, RouterRequestState>();
const initializations = new WeakMap<ExtensionAPI, Promise<void>>();

export function initializeRouterState(pi: ExtensionAPI): Promise<void> {
	let initialization = initializations.get(pi);
	if (!initialization) {
		initialization = loadRouterInstallationId()
			.then((id) => {
				setRouterState(pi, new RouterRequestState(id));
			})
			.catch((error: unknown) => {
				initializations.delete(pi);
				throw error;
			});
		initializations.set(pi, initialization);
	}
	return initialization;
}

export function routerStateFor(pi: ExtensionAPI): RouterRequestState {
	let state = requestStates.get(pi);
	if (!state) {
		state = new RouterRequestState();
		requestStates.set(pi, state);
	}
	return state;
}

export function setRouterState(pi: ExtensionAPI, state: RouterRequestState): void {
	requestStates.set(pi, state);
}

function registeredIdsFor(pi: ExtensionAPI): Set<string> {
	let ids = registeredIdsByApi.get(pi);
	if (!ids) {
		ids = new Set<string>();
		registeredIdsByApi.set(pi, ids);
	}
	return ids;
}

export function toProviderConfig(relay: RelayConfig, state = new RouterRequestState()): ProviderConfig {
	const models = structuredClone(relay.models);
	return {
		name: relay.name ?? relay.id,
		headers: relay.headers,
		baseUrl: relay.baseUrl.replace(/\/+$/, ""),
		apiKey: relay.apiKey,
		api: ROUTER_API,
		models: models.map((model) => ({ ...toRegisterModel(model), api: ROUTER_API })),
		streamSimple: (model, context, options) =>
			streamRouterCodex(model, context, options, {
				state,
				codex: models.find((entry) => entry.id === model.id)?.codex,
			}),
	};
}

export function applyRouterFile(pi: ExtensionAPI, file: RouterFile): void {
	routerStateFor(pi).reset();
	const registeredIds = registeredIdsFor(pi);
	const nextIds = new Set(file.relays.map((relay) => relay.id));
	for (const id of [...registeredIds]) {
		if (!nextIds.has(id)) unregisterOneRelay(pi, id);
	}
	for (const relay of file.relays) registerOneRelay(pi, relay);
}

export function registerOneRelay(pi: ExtensionAPI, relay: RelayConfig): void {
	routerStateFor(pi).reset();
	const registeredIds = registeredIdsFor(pi);
	if (relay.models.length === 0) {
		if (registeredIds.has(relay.id)) unregisterOneRelay(pi, relay.id);
		return;
	}
	pi.registerProvider(relay.id, toProviderConfig(relay, routerStateFor(pi)));
	registeredIds.add(relay.id);
}

export function unregisterOneRelay(pi: ExtensionAPI, id: string): void {
	routerStateFor(pi).reset();
	try {
		pi.unregisterProvider(id);
	} catch {
		// Ignore stale registrations after /reload.
	}
	registeredIdsFor(pi).delete(id);
}
