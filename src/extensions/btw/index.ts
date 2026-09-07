import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { BtwController } from "./controller.ts";

export default function btwExtension(pi: ExtensionAPI): void {
	const controller = new BtwController();
	let unsubscribeSubmit: (() => void) | undefined;
	pi.registerCommand("btw", {
		description: "Ask a temporary side question using the current context",
		handler: async (args, ctx) => {
			await controller.open(args, ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		unsubscribeSubmit?.();
		controller.close(false);
		if (ctx.mode === "tui") unsubscribeSubmit = ctx.ui.onEditorSubmit((event) => controller.intercept(event, ctx));
	});
	pi.on("session_tree", () => controller.close(false));
	pi.on("session_shutdown", () => {
		unsubscribeSubmit?.();
		unsubscribeSubmit = undefined;
		controller.close(false);
	});
}
