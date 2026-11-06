/** Loads and registers every highlight.js grammar on first use (see syntax-highlight.ts). */
export const loadHighlightLanguages = () => import("highlight.js/lib/index.js");
