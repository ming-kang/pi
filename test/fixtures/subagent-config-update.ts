import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentAgentName } from "../../src/extensions/subagent/constants.ts";
import { updateProfileOverride } from "../../src/extensions/subagent/settings.ts";

const [agentDir, profile, field, value] = process.argv.slice(2);
if (!agentDir || (profile !== "explorer" && profile !== "general") || !field || !value) {
	throw new Error("Usage: subagent-config-update <agent-dir> <profile> <model|thinking> <value>");
}

const patch =
	field === "model"
		? { model: value }
		: field === "thinking"
			? { thinking: value as ThinkingLevel }
			: undefined;
if (!patch) throw new Error(`Unknown field: ${field}`);
await updateProfileOverride(profile as SubagentAgentName, patch, agentDir);
