import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { openAgentSettings } from "./settings.ts";
import { createAgentTool } from "./tool.ts";

export { createAgentTool } from "./tool.ts";

export default function agentExtension(pi: ExtensionAPI): void {
	pi.registerTool(createAgentTool());
	pi.registerCommand("agent", {
		description: "Choose the model and thinking level for future Agents",
		handler: async (_args, ctx) => openAgentSettings(ctx),
	});
}
