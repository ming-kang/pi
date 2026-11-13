/**
 * Built-in models pane: a searchable list of a built-in provider's catalog.
 * Enter opens the model's override page; overridden models are marked so the
 * customized few stand out among hundreds of catalog entries.
 */

import "../keybindings.ts";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { builtinModelIds } from "../catalog.ts";
import { FilterListPane } from "./controls.ts";
import type { BuiltinModelsHost } from "./pane.ts";
import { renderPlainLine, truncateMiddle } from "./value-row.ts";

export class BuiltinModelsPane extends FilterListPane<string> {
	constructor(host: BuiltinModelsHost) {
		const ids = builtinModelIds(host.providerId);
		super(host, {
			items: (query) => {
				const trimmed = query.trim();
				return trimmed ? fuzzyFilter([...ids], trimmed, (id) => id) : ids;
			},
			renderItem: (id, { active, focused, width }) => {
				const overridden = host.store.getProvider(host.providerId)?.modelOverrides ?? {};
				const note = Object.hasOwn(overridden, id) ? "· overridden" : undefined;
				return renderPlainLine(host.theme, truncateMiddle(id, Math.max(8, width - 3 - (note?.length ?? 0))), {
					active,
					paneFocused: focused,
					note,
					width,
				});
			},
			emptyMessage: "No built-in models match.",
			footer: (entries) => [`${entries.length} of ${ids.length} built-in models`],
			confirmVerb: "open",
			searchVerb: "search",
			onConfirm: (id) => host.openOverride(id),
		});
	}
}
