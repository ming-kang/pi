import "./keybindings.ts";
import type { InlineExtension } from "../core/extensions/types.ts";
import btwExtension from "./btw/index.ts";
import cachedCompactionExtension from "./cached-compaction/index.ts";
import codemodeExtension from "./codemode/index.ts";
import deepwikiExtension from "./deepwiki/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import providerExtension from "./provider/index.ts";
import questionExtension from "./question/index.ts";
import runSummaryExtension from "./run-summary/index.ts";
import searchExtension from "./search/index.ts";
import statuslineExtension from "./statusline/index.ts";
import tasksExtension from "./tasks/index.ts";
import toolPresentationExtension from "./tool-presentation/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "cached-compaction", factory: cachedCompactionExtension, replaceable: true, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "btw", factory: btwExtension, builtin: true },
	{ name: "deepwiki", factory: deepwikiExtension, builtin: true },
	{ name: "provider", factory: providerExtension, builtin: true },
	{ name: "question", factory: questionExtension, builtin: true },
	{ name: "run-summary", factory: runSummaryExtension, replaceable: true, builtin: true },
	{ name: "statusline", factory: statuslineExtension, builtin: true },
	{ name: "tool-presentation", factory: toolPresentationExtension, builtin: true },
	{ name: "tasks", factory: tasksExtension, replaceable: true, builtin: true },
	{ name: "search", factory: searchExtension, builtin: true },
];
