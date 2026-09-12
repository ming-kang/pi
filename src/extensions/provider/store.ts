/**
 * Op-based models.json editing store.
 *
 * Three states are tracked: `baseline` (last known disk content), pending
 * field-level ops, and `view` (baseline + ops, what the UI renders). Every
 * confirmed edit queues an op and schedules a save. A save re-reads the file
 * under a cross-process lock and applies the pending ops onto that freshest
 * content — unrelated external edits are preserved, a same-field race
 * resolves last-writer-wins, and ops targeting externally removed models
 * simply miss. The candidate is validated via ModelConfig on a temp file,
 * backed up once per session, and atomically renamed into place. Failed
 * saves keep the ops pending; closing offers retry or explicit discard.
 * Whole-snapshot blind overwrites are never performed.
 *
 * Comments and custom formatting are normalized to two-space JSON on save;
 * unknown fields anywhere in the document are preserved verbatim.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { ModelConfig, type ModelsJsonModel, type ModelsJsonProvider } from "../../core/model-config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { stripJsonComments } from "../../utils/json.ts";
import { normalizePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { hasProviderSettings } from "./configuration.ts";
import { formatError } from "./constants.ts";

/** Sentinel op value removing the key at the op path. */
export const DELETE: unique symbol = Symbol("provider-store-delete");
export type DeleteMarker = typeof DELETE;

export interface ModelsJsonDocument {
	providers: Record<string, ModelsJsonProvider>;
	[key: string]: unknown;
}

interface OpBase {
	seq: number;
}
export interface SetFieldOp extends OpBase {
	kind: "set";
	providerId: string;
	/** Undefined for provider-level fields. */
	modelId?: string;
	/** Path within the provider/model object, e.g. ["compat", "allowEmptySignature"]. */
	path: readonly string[];
	value: unknown;
	createProvider: boolean;
}
export interface AddModelOp extends OpBase {
	kind: "addModel";
	providerId: string;
	model: ModelsJsonModel;
	createProvider: boolean;
}
export interface RemoveModelOp extends OpBase {
	kind: "removeModel";
	providerId: string;
	modelId: string;
}
export interface RenameModelOp extends OpBase {
	kind: "renameModel";
	providerId: string;
	oldId: string;
	newId: string;
}
export interface RemoveProviderOp extends OpBase {
	kind: "removeProvider";
	providerId: string;
}
export type Op = SetFieldOp | AddModelOp | RemoveModelOp | RenameModelOp | RemoveProviderOp;

export type SaveResult =
	| { kind: "clean" }
	| { kind: "saved"; applied: number }
	| { kind: "invalid"; error: string }
	| { kind: "error"; error: string };

export type StoreLoad = { ok: true; store: ModelsJsonStore } | { ok: false; error: string };

interface DiskRead {
	exists: boolean;
	doc: ModelsJsonDocument;
	rawText?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let current = root;
	for (const segment of path.slice(0, -1)) {
		const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
		if (isPlainObject(next)) current = next;
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

function cloneValue(value: unknown): unknown {
	return value === DELETE ? value : structuredClone(value);
}

async function readDocument(path: string): Promise<DiskRead> {
	let rawText: string;
	try {
		rawText = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, doc: { providers: {} } };
		throw error;
	}
	const parsed: unknown = JSON.parse(stripJsonComments(stripBom(rawText)));
	if (!isPlainObject(parsed)) throw new Error("models.json root must be a JSON object.");
	const doc = parsed as ModelsJsonDocument;
	if (!isPlainObject(doc.providers)) throw new Error('models.json "providers" must be an object.');
	return { exists: true, doc, rawText };
}

export class ModelsJsonStore {
	readonly path: string;
	private baseline: ModelsJsonDocument;
	private ops: Op[] = [];
	private view: ModelsJsonDocument;
	private seq = 0;
	private backedUp = false;
	private batching = false;
	private saveChain: Promise<void> = Promise.resolve();
	private readonly drafts = new Set<string>();
	private lastSaveResult: SaveResult = { kind: "clean" };
	/** Called after each save settles (success, conflict, or failure). */
	onSaveResult: ((result: SaveResult) => void) | undefined;

	private constructor(path: string, baseline: ModelsJsonDocument) {
		this.path = path;
		this.baseline = baseline;
		this.view = structuredClone(baseline);
	}

	static async load(path: string): Promise<StoreLoad> {
		let normalized = normalizePath(path);
		let disk: DiskRead;
		try {
			normalized = await realpath(normalized).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return normalized;
				throw error;
			});
			disk = await readDocument(normalized);
		} catch (error) {
			return { ok: false, error: `Failed to parse models.json: ${formatError(error)}\n\nFile: ${normalized}` };
		}
		if (disk.exists) {
			// Surface schema errors as a read-only state; never auto-overwrite an invalid file.
			const check = await ModelConfig.load(normalized);
			const validationError = check.getError();
			if (validationError) return { ok: false, error: validationError };
		}
		return { ok: true, store: new ModelsJsonStore(normalized, disk.doc) };
	}

	// ---------------------------------------------------------------------
	// View access (read-only for the UI; mutations go through the methods)
	// ---------------------------------------------------------------------

	getDoc(): ModelsJsonDocument {
		return this.view;
	}

	getProviderIds(): string[] {
		return [...new Set([...Object.keys(this.view.providers), ...this.ops.map((op) => op.providerId)])];
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return Object.hasOwn(this.view.providers, providerId) ? this.view.providers[providerId] : undefined;
	}

	/** Materialize a draft provider in the view without queueing an op (never written while empty). */
	ensureProviderView(providerId: string): void {
		if (Object.hasOwn(this.view.providers, providerId)) return;
		this.drafts.add(providerId);
		this.recomputeView();
	}

	/** Provider present in the view but not yet on disk. */
	isDraftProvider(providerId: string): boolean {
		return !Object.hasOwn(this.baseline.providers, providerId) && Object.hasOwn(this.view.providers, providerId);
	}

	getModels(providerId: string): ModelsJsonModel[] {
		const provider = this.getProvider(providerId);
		return Array.isArray(provider?.models) ? provider.models : [];
	}

	getModel(providerId: string, modelId: string): ModelsJsonModel | undefined {
		return this.getModels(providerId).find((model) => model.id === modelId);
	}

	get pendingCount(): number {
		return this.ops.length;
	}

	getPendingError(providerId?: string): string | undefined {
		const pending = this.ops.filter((op) => providerId === undefined || op.providerId === providerId);
		if (pending.length === 0) return undefined;
		if (this.lastSaveResult.kind === "error" || this.lastSaveResult.kind === "invalid")
			return this.lastSaveResult.error;
		return `${pending.length} change(s) are not saved; retry or discard before continuing.`;
	}

	retrySave(): void {
		if (this.ops.length > 0) this.scheduleSave();
	}

	/** Used only after flush, when the user explicitly discards unsaved edits. */
	discardPending(): void {
		this.ops = [];
		this.drafts.clear();
		this.recomputeView();
	}

	// ---------------------------------------------------------------------
	// Mutations (queue an op, refresh the view, schedule a save)
	// ---------------------------------------------------------------------

	private enqueue(op: Op): void {
		this.ops.push(op);
		this.recomputeView();
		this.scheduleSave();
	}

	private nextSeq(): number {
		return ++this.seq;
	}

	setProviderField(providerId: string, path: readonly string[], value: unknown): void {
		this.enqueue({
			kind: "set",
			seq: this.nextSeq(),
			providerId,
			path,
			value: cloneValue(value),
			createProvider: !Object.hasOwn(this.baseline.providers, providerId),
		});
	}

	setModelField(providerId: string, modelId: string, path: readonly string[], value: unknown): void {
		this.enqueue({
			kind: "set",
			seq: this.nextSeq(),
			providerId,
			modelId,
			path,
			value: cloneValue(value),
			createProvider: !Object.hasOwn(this.baseline.providers, providerId),
		});
	}

	addModel(providerId: string, model: ModelsJsonModel): void {
		this.enqueue({
			kind: "addModel",
			seq: this.nextSeq(),
			providerId,
			model: structuredClone(model),
			createProvider: !Object.hasOwn(this.baseline.providers, providerId),
		});
	}

	removeModel(providerId: string, modelId: string): void {
		this.enqueue({
			kind: "removeModel",
			seq: this.nextSeq(),
			providerId,
			modelId,
		});
	}

	async renameModel(providerId: string, oldId: string, newId: string): Promise<string | undefined> {
		await this.flush();
		const pendingError = this.getPendingError(providerId);
		if (pendingError) return pendingError;
		const before = this.getModel(providerId, oldId);
		if (!before) return "The model no longer exists.";
		const seq = this.nextSeq();
		this.enqueue({
			kind: "renameModel",
			seq,
			providerId,
			oldId,
			newId,
		});
		await this.flush();
		if (this.ops.some((op) => op.seq === seq)) {
			// The save failed; drop the rename rather than surprising the user later.
			this.ops = this.ops.filter((op) => op.seq !== seq);
			this.recomputeView();
			return this.getPendingError(providerId) ?? "Failed to save models.json.";
		}
		// A settled rename can still have missed when the model moved on disk; never
		// adopt an unrelated model that already uses the destination id.
		const renamed = this.getModel(providerId, newId);
		return renamed && jsonEquals(renamed, { ...before, id: newId })
			? undefined
			: "The model changed on disk; reopen it before renaming.";
	}

	removeProvider(providerId: string): void {
		this.enqueue({
			kind: "removeProvider",
			seq: this.nextSeq(),
			providerId,
		});
	}

	/** Queue several ops but schedule a single save (batch import, built-in data apply). */
	batch(mutate: () => void): void {
		this.batching = true;
		try {
			mutate();
		} finally {
			this.batching = false;
		}
		if (this.ops.length > 0) this.scheduleSave();
	}

	/** Drop all pending ops targeting a draft provider (used when leaving its editor untouched). */
	discardProviderDraft(providerId: string): void {
		this.drafts.delete(providerId);
		if (Object.hasOwn(this.baseline.providers, providerId)) return;
		this.ops = this.ops.filter((op) => op.providerId !== providerId);
		this.recomputeView();
	}

	// ---------------------------------------------------------------------
	// View computation
	// ---------------------------------------------------------------------

	private recomputeView(): void {
		const view = structuredClone(this.baseline);
		for (const id of this.drafts) ensureProvider(view, id);
		for (const op of this.ops) applyOp(view, op);
		this.view = view;
	}

	// ---------------------------------------------------------------------
	// Saving
	// ---------------------------------------------------------------------

	private scheduleSave(): void {
		if (this.batching) return;
		this.saveChain = this.saveChain
			.catch(() => {})
			.then(async () => {
				const result = await this.save();
				this.lastSaveResult = result;
				if (result.kind !== "clean") this.onSaveResult?.(result);
			});
	}

	/** Wait for all scheduled saves; the settled result of the last save, if any. */
	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.saveChain;
			await pending;
		} while (pending !== this.saveChain);
	}

	private async save(): Promise<SaveResult> {
		if (this.ops.length === 0) return { kind: "clean" };
		try {
			return await withFileMutationQueue(this.path, async () => {
				await mkdir(dirname(this.path), { recursive: true });
				let compromised: Error | undefined;
				const release = await lockfile.lock(this.path, {
					realpath: false,
					stale: 30_000,
					retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 250 },
					onCompromised: (error) => {
						compromised = error;
					},
				});
				let result: SaveResult;
				try {
					result = await this.saveLocked(() => {
						if (compromised) throw compromised;
					});
				} catch (error) {
					result = { kind: "error", error: `Failed to save models.json: ${formatError(error)}` };
				}
				try {
					await release();
				} catch (error) {
					if (!compromised && result.kind !== "error" && result.kind !== "invalid") {
						result = { kind: "error", error: `Could not release the models.json lock: ${formatError(error)}` };
					}
				}
				return result;
			});
		} catch (error) {
			return { kind: "error", error: `Failed to access models.json for saving: ${formatError(error)}` };
		}
	}

	private async saveLocked(assertLock: () => void): Promise<SaveResult> {
		const tempPath = join(dirname(this.path), `.models.${randomUUID()}.tmp`);
		try {
			assertLock();
			let disk: DiskRead;
			try {
				disk = await readDocument(this.path);
			} catch (error) {
				// Never clobber a file we cannot parse.
				return { kind: "error", error: `models.json changed on disk and is unreadable: ${formatError(error)}` };
			}
			const working = structuredClone(disk.doc);
			const batch = this.ops.filter((op) => {
				const provider = this.getProvider(op.providerId);
				return (
					Object.hasOwn(disk.doc.providers, op.providerId) ||
					!provider ||
					Object.keys(provider).length === 0 ||
					hasProviderSettings(provider)
				);
			});
			// Apply blindly onto the freshest disk content: unrelated external
			// edits are preserved, a same-field race resolves last-writer-wins,
			// and ops targeting externally removed models simply miss.
			for (const op of batch) applyOp(working, op);
			pruneEmptyNewProviders(working, disk.doc);
			const settle = () => {
				const settled = new Set(batch.map((op) => op.seq));
				this.ops = this.ops.filter((op) => !settled.has(op.seq));
				this.recomputeView();
			};
			if (jsonEquals(working, disk.doc)) {
				// Ops cancelled each other out or already matched disk; nothing to write.
				this.baseline = disk.doc;
				settle();
				return { kind: "saved", applied: batch.length };
			}
			const candidate = `${JSON.stringify(working, null, 2)}\n`;
			await writeFile(tempPath, candidate, { encoding: "utf8", mode: 0o600 });
			const check = await ModelConfig.load(tempPath);
			const validationError = check.getError();
			if (validationError) {
				return { kind: "invalid", error: validationError };
			}
			const latest = await readDocument(this.path);
			if (latest.exists !== disk.exists || latest.rawText !== disk.rawText) {
				throw new Error("models.json changed while saving; the edits were kept for retry.");
			}
			if (!this.backedUp && disk.exists && disk.rawText !== undefined) {
				await writeFile(`${this.path}.bak`, disk.rawText, { encoding: "utf8", mode: 0o600 });
				this.backedUp = true;
			}
			assertLock();
			await rename(tempPath, this.path);
			this.baseline = working;
			settle();
			return { kind: "saved", applied: batch.length };
		} finally {
			await rm(tempPath, { force: true }).catch(() => {});
		}
	}
}

// -------------------------------------------------------------------------
// Op application
// -------------------------------------------------------------------------

function ensureProvider(doc: ModelsJsonDocument, providerId: string): Record<string, unknown> {
	const existing = Object.hasOwn(doc.providers, providerId) ? doc.providers[providerId] : undefined;
	if (existing) return existing;
	const created: Record<string, unknown> = {};
	Object.defineProperty(doc.providers, providerId, {
		value: created,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return created;
}

function applyOp(doc: ModelsJsonDocument, op: Op): void {
	switch (op.kind) {
		case "set": {
			const provider = ensureProvider(doc, op.providerId);
			if (op.modelId === undefined) {
				setPath(provider, op.path, op.value);
				return;
			}
			const models = Array.isArray(provider.models) ? (provider.models as Record<string, unknown>[]) : [];
			const model = models.find((entry) => entry.id === op.modelId);
			if (model) setPath(model, op.path, op.value);
			return;
		}
		case "addModel": {
			const provider = ensureProvider(doc, op.providerId);
			const models = Array.isArray(provider.models) ? (provider.models as Record<string, unknown>[]) : [];
			const index = models.findIndex((entry) => entry.id === op.model.id);
			const clone = structuredClone(op.model) as Record<string, unknown>;
			if (index >= 0) models[index] = clone;
			else models.push(clone);
			provider.models = models;
			return;
		}
		case "removeModel": {
			const provider = doc.providers[op.providerId] as Record<string, unknown> | undefined;
			const models = Array.isArray(provider?.models) ? (provider.models as Record<string, unknown>[]) : undefined;
			if (!provider || !models) return;
			provider.models = models.filter((entry) => entry.id !== op.modelId);
			return;
		}
		case "renameModel": {
			const provider = doc.providers[op.providerId] as Record<string, unknown> | undefined;
			const models = Array.isArray(provider?.models) ? (provider.models as Record<string, unknown>[]) : undefined;
			if (!models) return;
			const model = models.find((entry) => entry.id === op.oldId);
			if (model && !models.some((entry) => entry.id === op.newId)) model.id = op.newId;
			return;
		}
		case "removeProvider": {
			delete doc.providers[op.providerId];
			return;
		}
	}
}

/** Remove providers the ops materialized but which ended up with no keys (self-cancelled drafts). */
function pruneEmptyNewProviders(working: ModelsJsonDocument, disk: ModelsJsonDocument): void {
	for (const [providerId, provider] of Object.entries(working.providers)) {
		if (Object.hasOwn(disk.providers, providerId)) continue;
		if (isPlainObject(provider) && Object.keys(provider).length === 0) delete working.providers[providerId];
	}
}
