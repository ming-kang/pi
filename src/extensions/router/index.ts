/**
 * router — Codex-style API relays for Pi.
 *
 * Manages ~/.pi/agent/router.json. Each relay is registered with
 * pi.registerProvider (legacy config form + streamSimple), following Pi's
 * custom-provider docs: streamSimple wraps openAIResponsesApi from
 * @earendil-works/pi-ai/compat and reshapes the payload for Codex-style relays.
 *
 * /router: relay/catalog/model configuration. Normal API-key SSE requests follow
 * the pinned Codex client profile; pi-ai continues to own the Responses protocol.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { COMMAND_DESCRIPTION, COMMAND_NAME, formatError } from "./constants.ts";
import { applyRouterFile, initializeRouterState, routerStateFor } from "./register.ts";
import { loadRouterFile } from "./store.ts";
import { runRouterCommand } from "./ui.ts";

/** Async factory so relays are registered before interactive startup / --list-models. */
export default async function routerExtension(pi: ExtensionAPI): Promise<void> {
	const reset = () => routerStateFor(pi).reset();
	pi.on("before_agent_start", reset);
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("model_select", reset);
	pi.on("session_shutdown", reset);
	try {
		const file = await loadRouterFile();
		// Factory invocations without relays should have no filesystem side effects.
		if (file.relays.length > 0) await initializeRouterState(pi);
		applyRouterFile(pi, file);
	} catch (error) {
		console.error(`[router] failed to load config: ${formatError(error)}`);
	}

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: async (prefix) => {
			const first = prefix.trim().toLowerCase();
			const commands = [
				{ value: "add", label: "add", description: "Add a relay" },
				{ value: "list", label: "list", description: "Browse relays" },
				{ value: "reload", label: "reload", description: "Re-register from disk" },
			].filter((item) => !first || item.value.startsWith(first));
			try {
				const file = await loadRouterFile();
				const relays = file.relays
					.filter((relay) => !first || relay.id.toLowerCase().startsWith(first))
					.map((relay) => ({
						value: relay.id,
						label: relay.id,
						description: `${relay.models.length} model(s)`,
					}));
				const combined = [...commands, ...relays];
				return combined.length > 0 ? combined : null;
			} catch {
				return commands.length > 0 ? commands : null;
			}
		},
		handler: async (args, ctx) => {
			try {
				await runRouterCommand(args, ctx, pi);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}
