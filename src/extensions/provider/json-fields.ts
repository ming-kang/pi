/** JSON field updates shared by drafts and queued store operations. */
export const DELETE: unique symbol = Symbol("provider-store-delete");
export type DeleteMarker = typeof DELETE;

export function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let current = root;
	for (const segment of path.slice(0, -1)) {
		const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
		if (typeof next === "object" && next !== null && !Array.isArray(next)) current = next as Record<string, unknown>;
		else {
			const created: Record<string, unknown> = {};
			Object.defineProperty(current, segment, {
				value: created,
				writable: true,
				enumerable: true,
				configurable: true,
			});
			current = created;
		}
	}
	const leaf = path[path.length - 1]!;
	if (value === DELETE) delete current[leaf];
	else
		Object.defineProperty(current, leaf, {
			value: structuredClone(value),
			writable: true,
			enumerable: true,
			configurable: true,
		});
}
