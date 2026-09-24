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
		controller.close();
		unsubscribeSubmit = ctx.ui.editorHost?.onSubmit((event) => controller.intercept(event, ctx));
	});
	pi.on("session_tree", () => controller.close());
	pi.on("session_shutdown", () => {
		unsubscribeSubmit?.();
		unsubscribeSubmit = undefined;
		controller.close();
	});
}
