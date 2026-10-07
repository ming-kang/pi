import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { CODE_TOOL_NAME, WEB_TOOL_NAME } from "./constants.ts";
import { getApiKey } from "./keystore.ts";

export function reconcileSearchTools(pi: ExtensionAPI): void {
	const hasKey = !!getApiKey();
	const active = new Set(pi.getActiveTools());
	let changed = false;
	for (const name of [CODE_TOOL_NAME, WEB_TOOL_NAME]) {
		if (!hasKey && active.delete(name)) changed = true;
		else if (hasKey && !active.has(name)) {
			active.add(name);
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...active]);
}
