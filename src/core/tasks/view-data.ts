/** Executor-owned JSON data; the version belongs to its view provider. */
export interface TaskViewData {
	version: number;
	data: unknown;
}

/** Strict, bounded JSON copy. Never invoke accessors, toJSON, or renderer callbacks. */
export function readTaskViewData(source: unknown): TaskViewData {
	let budget = 120 * 1024;
	const copy = (value: unknown, depth: number): unknown => {
		if (depth > 32 || --budget < 0) throw new Error("Task view data exceeds storage limits");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") {
			if (value.length > budget) throw new Error("Task view data exceeds storage limits");
			budget -= Buffer.byteLength(JSON.stringify(value));
			if (budget < 0) throw new Error("Task view data exceeds storage limits");
			return value;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			budget -= 24;
			return value;
		}
		if (typeof value !== "object" || value === null) throw new Error("Task view data must be JSON");
		const array = Array.isArray(value);
		if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			throw new Error("Task view data must contain plain objects");
		const output: Record<string, unknown> = {};
		const entries: unknown[] = [];
		for (const key of Object.keys(value)) {
			if (array && key !== String(entries.length)) throw new Error("Task view arrays must be dense JSON arrays");
			const field = Object.getOwnPropertyDescriptor(value, key)!;
			if (!("value" in field)) throw new Error("Task view data cannot contain accessors");
			if (field.value === undefined && !array) continue;
			copy(key, depth + 1);
			const next = copy(field.value, depth + 1);
			if (array) entries.push(next);
			else Object.defineProperty(output, key, { value: next, enumerable: true, writable: true, configurable: true });
		}
		if (array && entries.length !== value.length) throw new Error("Task view arrays must be dense JSON arrays");
		return array ? entries : output;
	};
	const result = copy(source, 0) as Partial<TaskViewData> | null;
	if (budget < 0) throw new Error("Task view data exceeds storage limits");
	if (
		!result ||
		typeof result.version !== "number" ||
		!Number.isSafeInteger(result.version) ||
		result.version < 1 ||
		!Object.hasOwn(result, "data")
	)
		throw new Error("Invalid task view data envelope");
	// Traversal already bounds the allocation; enforce the exact serialized limit too.
	if (Buffer.byteLength(JSON.stringify(result)) > 120 * 1024) throw new Error("Task view data exceeds storage limits");
	return { version: result.version, data: result.data };
}
