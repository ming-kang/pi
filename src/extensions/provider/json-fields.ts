/** JSON field updates shared by drafts and queued store operations. */
export const DELETE: unique symbol = Symbol("provider-store-delete");
export type DeleteMarker = typeof DELETE;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical comparison for JSON values, insensitive to object key order. */
export function jsonEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((entry, index) => jsonEquals(entry, b[index]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a).sort();
		const bKeys = Object.keys(b).sort();
		return (
			aKeys.length === bKeys.length &&
			aKeys.every((key, index) => key === bKeys[index] && jsonEquals(a[key], b[key]))
		);
	}
	return false;
}

/** The value at `path` through own object keys; undefined when any step is missing. */
export function getPath(root: unknown, path: readonly string[]): unknown {
	let node = root;
	for (const key of path) {
		if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

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
