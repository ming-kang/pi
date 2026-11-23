import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import { extractSkillAutocompleteToken, type SkillAutocompleteToken } from "../../core/skill-references.ts";

const SKILL_COMMAND_PREFIX = "skill:";

/** The `/skill` token before the cursor and the skills it currently lists. */
export interface SkillCompletion {
	token: SkillAutocompleteToken;
	items: AutocompleteItem[];
}

export interface SkillAutocompleteProvider extends AutocompleteProvider {
	/** Returns the `/skill` token before the cursor with its matching skills; undefined outside a token or without skills. */
	getSkillCompletion(lines: readonly string[], cursorLine: number, cursorCol: number): SkillCompletion | undefined;
}

export function isSkillAutocompleteProvider(provider: AutocompleteProvider): provider is SkillAutocompleteProvider {
	return "getSkillCompletion" in provider;
}

export function createSkillAutocompleteProvider(
	baseProvider: AutocompleteProvider,
	skillCommands: readonly SlashCommand[],
): SkillAutocompleteProvider {
	const skillItems: AutocompleteItem[] = skillCommands.map((cmd) => {
		const bareName = cmd.name.startsWith(SKILL_COMMAND_PREFIX)
			? cmd.name.slice(SKILL_COMMAND_PREFIX.length)
			: cmd.name;
		return {
			value: `/skill:${bareName}`,
			label: bareName,
			...(cmd.description && { description: cmd.description }),
		};
	});

	const getSkillCompletion = (
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
	): SkillCompletion | undefined => {
		if (skillItems.length === 0) return undefined;
		const token = extractSkillAutocompleteToken(lines, cursorLine, cursorCol);
		if (!token) return undefined;
		return { token, items: token.query ? fuzzyFilter(skillItems, token.query, (item) => item.label) : skillItems };
	};

	return {
		...(baseProvider.triggerCharacters && { triggerCharacters: baseProvider.triggerCharacters }),
		getSkillCompletion,

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const completion = getSkillCompletion(lines, cursorLine, cursorCol);
			if (completion && completion.items.length > 0) {
				return { items: completion.items, prefix: completion.token.prefix };
			}
			// `/skill:query` without matches shows nothing; `/skill query` reads as prose once nothing matches.
			if (completion && !completion.token.hasSpace) return null;
			return baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (item.value.startsWith("/skill:") && prefix.startsWith("/skill")) {
				const currentLine = lines[cursorLine] ?? "";
				const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
				const afterCursor = currentLine.slice(cursorCol);
				const suffix = afterCursor.startsWith(" ") ? "" : " ";
				const newLine = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
				const newLines = [...lines];
				newLines[cursorLine] = newLine;
				return {
					lines: newLines,
					cursorLine,
					cursorCol: beforePrefix.length + item.value.length + 1,
				};
			}
			return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (getSkillCompletion(lines, cursorLine, cursorCol)) return true;
			return baseProvider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
