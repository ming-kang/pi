import type { AgentDefinition } from "./types.ts";

/** Convert a lowercase profile identifier into its display-only title. */
export function displayAgentName(name: string): string {
	return name
		.split(/[-_]/u)
		.filter(Boolean)
		.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
		.join(" ");
}

/** Keep model-facing usage guidance separate from concise built-in UI copy. */
export function displayAgentDescription(agent: AgentDefinition): string {
	return agent.uiDescription ?? agent.description;
}
