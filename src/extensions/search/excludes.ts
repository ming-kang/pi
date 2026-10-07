/** Canonical noise-directory list shared by the repo-map tree (tree.ts) and the
 * hotspot scorer (directory-scorer.ts), so a directory can never be scored but
 * hidden from the tree. prompt.ts deliberately keeps its own byte-identical
 * exclude advice from upstream — do not sync the two. */

export const DEFAULT_EXCLUDES: readonly string[] = [
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".venv",
	"venv",
	"target",
	"out",
	".cache",
	"__pycache__",
	"vendor",
	"deps",
	"third_party",
	"logs",
	"data",
	".next",
	".nuxt",
	".turbo",
	".idea",
	"bundle",
	"bundled",
	"fixtures",
];
