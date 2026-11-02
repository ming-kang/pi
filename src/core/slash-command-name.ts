/**
 * The command `/name args` input names, split at the first space as command dispatch splits it;
 * undefined for input that is not a slash command.
 */
export function slashCommandName(text: string): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const spaceIndex = text.indexOf(" ");
	return spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
}
