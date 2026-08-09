import type { InlineExtension } from "../core/extensions/types.ts";
import biuExtension from "./biu/index.ts";
import deepwikiExtension from "./deepwiki/index.ts";
import llamaExtension from "./llama/index.ts";
import questionExtension from "./question/index.ts";
import routerExtension from "./router/index.ts";
import statuslineExtension from "./statusline/index.ts";
import subagentExtension from "./subagent/index.ts";
import todoExtension from "./todo/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "biu", factory: biuExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "deepwiki", factory: deepwikiExtension, hidden: true },
	{ name: "question", factory: questionExtension, hidden: true },
	{ name: "router", factory: routerExtension, hidden: true },
	{ name: "statusline", factory: statuslineExtension, hidden: true },
	{ name: "subagent", factory: subagentExtension, hidden: true },
	{ name: "todo", factory: todoExtension, hidden: true },
];
