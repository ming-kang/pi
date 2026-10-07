import { type Static, Type } from "typebox";

export const CodeSearchParamsSchema = Type.Object({
	query: Type.String({
		description:
			"Short natural-language search query. English is recommended for best semantic matching; translate Chinese task descriptions into concise English while preserving code identifiers, API names, file names, exact errors, and user-facing literals. Describe the behavior, flow, error, API, or concept to locate; do not pass only an exact symbol, filename, or literal.",
	}),
	project_path: Type.Optional(
		Type.String({
			description:
				"Optional relative or absolute package/subtree path to search. It must resolve inside the current working directory. Defaults to cwd; narrow this for monorepos or known subsystems.",
		}),
	),
	tree_depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 4,
			description:
				"Repo-map skeleton depth (1-4, default 2). The map is trimmed to its byte budget, so a deep tree on a large repo falls back automatically; raise it only for a small repository you want to see whole.",
		}),
	),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5,
			description:
				"Search/planning rounds (1-5, default 3). Use 1-2 for quick orientation, 3 for normal searches, and 4-5 only for complex cross-module tracing.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 30,
			description:
				"Maximum candidate files to return (1-30, default 10). Prefer 3-8 for focused implementation work; increase only for broad exploration.",
		}),
	),
	exclude_paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Extra directory/file names to exclude from repo-map and hotspot scoring. Defaults already hide common noise and simple .gitignore dirs; add generated, vendor, build, or bulky outputs when needed.",
		}),
	),
});

export type CodeSearchParams = Static<typeof CodeSearchParamsSchema>;

export const WebSearchParamsSchema = Type.Object({
	query: Type.String({
		description:
			"Search query for the live web. Be specific and include version numbers, product names, or error " +
			"text; translate Chinese task descriptions into English when the target sources are English docs.",
	}),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10,
			description: "Maximum results to return (1-10, default 5). Use 3-5 for most questions; 10 for broad surveys.",
		}),
	),
});

export type WebSearchParams = Static<typeof WebSearchParamsSchema>;
