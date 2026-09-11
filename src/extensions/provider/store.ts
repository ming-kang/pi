/**
 * Op-based models.json editing store.
 *
 * Three states are tracked: `baseline` (last known disk content), pending
 * field-level ops, and `view` (baseline + ops, what the UI renders). Every
 * confirmed edit queues an op and schedules a save. A save re-reads the file
 * under a cross-process lock, applies ops whose field was not externally
 * modified since baseline, merges unrelated external changes, validates the
 * candidate via ModelConfig on a temp file, backs up once per session, and
 * atomically replaces models.json. Conflicting ops stay pending for the UI
 * to resolve. Whole-snapshot blind overwrites are never performed.
 *
 * Comments and custom formatting are normalized to two-space JSON on save;
 * unknown fields anywhere in the document are preserved verbatim.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { ModelConfig, type ModelsJsonModel, type ModelsJsonProvider } from "../../core/model-config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { stripJsonComments } from "../../utils/json.ts";
import { normalizePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { formatError } from "./constants.ts";

/** Sentinel op value removing the key at the op path. */
export const DELETE: unique symbol = Symbol("provider-store-delete");
export type DeleteMarker = typeof DELETE;
/** Sentinel for "key absent" in op baselines. */
const MISSING: unique symbol = Symbol("provider-store-missing");

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
	/** Value at path in baseline when the op was queued; MISSING when the key was absent. */
	base: unknown;
}
export interface AddModelOp extends OpBase {
	kind: "addModel";
	providerId: string;
	model: ModelsJsonModel;
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

export interface SaveConflict {
	op: Op;
	/** Human-readable location, e.g. `CPA › kimi-k3 › contextWindow`. */
	location: string;
	/** External value found on disk (MISSING-rendered as "(absent)"). */
	external: string;
	/** Value the user tried to write. */
	attempted: string;
	/** Raw external value for rebase-on-keep; MISSING when the key is absent on disk. */
	externalRaw: unknown;
	externalPresent: boolean;
}

export type SaveResult =
	| { kind: "clean" }
	| { kind: "saved"; applied: number; conflicts: SaveConflict[] }
	| { kind: "conflict"; conflicts: SaveConflict[] }
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

function getPath(root: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = root;
	for (const segment of path) {
		if (!isPlainObject(current)) return MISSING;
		current = segment in current ? current[segment] : MISSING;
		if (current === MISSING) return MISSING;
	}
	return current;
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let current = root;
	for (const segment of path.slice(0, -1)) {
		const next = current[segment];
		if (isPlainObject(next)) current = next;
		else {
			const created: Record<string, unknown> = {};
			current[segment] = created;
			current = created;
		}
	}
	const leaf = path[path.length - 1]!;
	if (value === DELETE) delete current[leaf];
	else current[leaf] = value;
}

function renderValue(value: unknown): string {
	if (value === MISSING) return "(absent)";
	if (value === DELETE) return "(removed)";
	if (typeof value === "string") return JSON.stringify(value);
	const text = JSON.stringify(value);
	return text === undefined ? String(value) : text;
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
	private wroteOnce = false;
	private batching = false;
	private saveChain: Promise<void> = Promise.resolve();
	/** Called after each save settles (success, conflict, or failure). */
	onSaveResult: ((result: SaveResult) => void) | undefined;

	private constructor(path: string, baseline: ModelsJsonDocument) {
		this.path = path;
		this.baseline = baseline;
		this.view = baseline;
	}

	static async load(path: string): Promise<StoreLoad> {
		const normalized = normalizePath(path);
		let disk: DiskRead;
		try {
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
		return Object.keys(this.view.providers);
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.view.providers[providerId];
	}

	/** Materialize a draft provider in the view without queueing an op (never written while empty). */
	ensureProviderView(providerId: string): void {
		if (providerId in this.view.providers) return;
		this.view.providers[providerId] = {};
	}

	/** Provider present in the view but not yet on disk. */
	isDraftProvider(providerId: string): boolean {
		return !(providerId in this.baseline.providers) && providerId in this.view.providers;
	}

	getModels(providerId: string): ModelsJsonModel[] {
		const provider = this.view.providers[providerId];
		return Array.isArray(provider?.models) ? provider.models : [];
	}

	getModel(providerId: string, modelId: string): ModelsJsonModel | undefined {
		return this.getModels(providerId).find((model) => model.id === modelId);
	}

	get pendingCount(): number {
		return this.ops.length;
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

	private baselineValue(providerId: string, modelId: string | undefined, path: readonly string[]): unknown {
		const provider = this.baseline.providers[providerId] as Record<string, unknown> | undefined;
		if (!provider) return MISSING;
		if (modelId === undefined) return getPath(provider, path);
		const models = Array.isArray(provider.models) ? (provider.models as Record<string, unknown>[]) : [];
		const model = models.find((entry) => entry.id === modelId);
		if (!model) return MISSING;
		return getPath(model, path);
	}

	setProviderField(providerId: string, path: readonly string[], value: unknown): void {
		this.enqueue({
			kind: "set",
			seq: this.nextSeq(),
			providerId,
			path,
			value,
			base: this.baselineValue(providerId, undefined, path),
		});
	}

	setModelField(providerId: string, modelId: string, path: readonly string[], value: unknown): void {
		this.enqueue({
			kind: "set",
			seq: this.nextSeq(),
			providerId,
			modelId,
			path,
			value,
			base: this.baselineValue(providerId, modelId, path),
		});
	}

	addModel(providerId: string, model: ModelsJsonModel): void {
		this.enqueue({ kind: "addModel", seq: this.nextSeq(), providerId, model: structuredClone(model) });
	}

	removeModel(providerId: string, modelId: string): void {
		this.enqueue({ kind: "removeModel", seq: this.nextSeq(), providerId, modelId });
	}

	renameModel(providerId: string, oldId: string, newId: string): void {
		this.enqueue({ kind: "renameModel", seq: this.nextSeq(), providerId, oldId, newId });
	}

	removeProvider(providerId: string): void {
		this.enqueue({ kind: "removeProvider", seq: this.nextSeq(), providerId });
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

	/** True after the first successful write of this session (drives the one-time format notice). */
	get hasWritten(): boolean {
		return this.wroteOnce;
	}

	/** Drop all pending ops targeting a draft provider (used when leaving its editor untouched). */
	discardProviderDraft(providerId: string): void {
		if (providerId in this.baseline.providers) return;
		this.ops = this.ops.filter((op) => op.providerId !== providerId);
		this.recomputeView();
	}

	/**
	 * Resolve a held conflict: "keep" rebases the op onto the external value so
	 * the next save overwrites it; "external" drops the op.
	 */
	resolveConflict(seq: number, action: "keep" | "external", externalValue: unknown, externalPresent: boolean): void {
		const op = this.ops.find((entry) => entry.seq === seq);
		if (!op) return;
		if (action === "external") this.ops = this.ops.filter((entry) => entry.seq !== seq);
		else if (op.kind === "set") op.base = externalPresent ? externalValue : MISSING;
		this.recomputeView();
		if (action === "keep") this.scheduleSave();
	}

	// ---------------------------------------------------------------------
	// View computation
	// ---------------------------------------------------------------------

	private recomputeView(): void {
		const view = structuredClone(this.baseline);
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
				if (result.kind !== "clean") this.onSaveResult?.(result);
			});
	}

	/** Wait for all scheduled saves; the settled result of the last save, if any. */
	async flush(): Promise<void> {
		await this.saveChain;
	}

	private async save(): Promise<SaveResult> {
		if (this.ops.length === 0) return { kind: "clean" };
		return withFileMutationQueue(this.path, async () => {
			let compromised: Error | undefined;
			let release: (() => Promise<void>) | undefined;
			let releaseFailure: unknown;
			try {
				release = await lockfile.lock(this.path, {
					realpath: false,
					stale: 30_000,
					retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 250 },
					onCompromised: (error) => {
						compromised = error;
					},
				});
			} catch (error) {
				return { kind: "error", error: `Failed to lock models.json: ${formatError(error)}` };
			}
			const tempPath = join(dirname(this.path), `.models.${process.pid}.${Date.now()}.tmp`);
			try {
				if (compromised) throw compromised;
				let disk: DiskRead;
				try {
					disk = await readDocument(this.path);
				} catch (error) {
					// Never clobber a file we cannot parse.
					return { kind: "error", error: `models.json changed on disk and is unreadable: ${formatError(error)}` };
				}
				const working = structuredClone(disk.doc);
				const conflicts: SaveConflict[] = [];
				const applied: Op[] = [];
				const held: Op[] = [];
				let needsWrite = false;
				for (const op of this.ops) {
					const outcome = classifyOp(op, disk.doc, this.baseline);
					if (outcome === "conflict") {
						held.push(op);
						conflicts.push(describeConflict(op, disk.doc));
						continue;
					}
					if (outcome === "apply") {
						applyOp(working, op);
						needsWrite = true;
					}
					applied.push(op); // "reached" ops need no write but are settled
				}
				if (needsWrite) {
					pruneEmptyNewProviders(working, disk.doc);
					const candidate = `${JSON.stringify(working, null, 2)}\n`;
					if (jsonEquals(working, disk.doc)) {
						// Ops cancelled each other out; nothing to write.
						this.baseline = disk.doc;
						this.ops = held;
						this.recomputeView();
						return held.length > 0
							? { kind: "conflict", conflicts }
							: { kind: "saved", applied: applied.length, conflicts };
					}
					await mkdir(dirname(this.path), { recursive: true });
					await writeFile(tempPath, candidate, { encoding: "utf8", mode: 0o600 });
					const check = await ModelConfig.load(tempPath);
					const validationError = check.getError();
					if (validationError) {
						await rm(tempPath, { force: true });
						return { kind: "invalid", error: validationError };
					}
					if (!this.backedUp && disk.exists && disk.rawText !== undefined) {
						await writeFile(`${this.path}.bak`, disk.rawText, { encoding: "utf8", mode: 0o600 });
						this.backedUp = true;
					}
					if (compromised) throw compromised;
					await rename(tempPath, this.path);
					this.wroteOnce = true;
				}
				this.baseline = needsWrite ? working : disk.doc;
				this.ops = held;
				this.recomputeView();
				if (held.length > 0) return { kind: "conflict", conflicts };
				return { kind: "saved", applied: applied.length, conflicts };
			} catch (error) {
				await rm(tempPath, { force: true }).catch(() => {});
				return { kind: "error", error: `Failed to save models.json: ${formatError(error)}` };
			} finally {
				if (release) {
					try {
						await release();
					} catch (error) {
						// A compromised lock is already released by proper-lockfile; retain the original error.
						if (!compromised) releaseFailure = error;
					}
				}
			}
			if (releaseFailure) {
				return { kind: "error", error: `Failed to release the models.json lock: ${formatError(releaseFailure)}` };
			}
		});
	}
}

// -------------------------------------------------------------------------
// Op application & conflict classification
// -------------------------------------------------------------------------

function ensureProvider(doc: ModelsJsonDocument, providerId: string): Record<string, unknown> {
	const existing = doc.providers[providerId] as Record<string, unknown> | undefined;
	if (existing) return existing;
	const created: Record<string, unknown> = {};
	doc.providers[providerId] = created as ModelsJsonProvider;
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

/** "apply" writes the op, "reached" means disk already matches the goal, "conflict" means the field moved externally. */
function classifyOp(op: Op, disk: ModelsJsonDocument, baseline: ModelsJsonDocument): "apply" | "reached" | "conflict" {
	switch (op.kind) {
		case "set": {
			const provider = disk.providers[op.providerId] as Record<string, unknown> | undefined;
			let diskValue: unknown = MISSING;
			if (provider) {
				if (op.modelId === undefined) diskValue = getPath(provider, op.path);
				else {
					const models = Array.isArray(provider.models) ? (provider.models as Record<string, unknown>[]) : [];
					const model = models.find((entry) => entry.id === op.modelId);
					if (model) diskValue = getPath(model, op.path);
				}
			}
			if (jsonEquals(diskValue, op.base)) return jsonEquals(diskValue, op.value) ? "reached" : "apply";
			// Externally moved; already at goal?
			return jsonEquals(diskValue, op.value) ? "reached" : "conflict";
		}
		case "addModel": {
			const provider = disk.providers[op.providerId];
			const existing = provider?.models?.find((model) => model.id === op.model.id);
			if (!existing) return "apply";
			const baselineProvider = baseline.providers[op.providerId];
			const baselineModel = baselineProvider?.models?.find((model) => model.id === op.model.id);
			// our own duplicate retry
			if (baselineModel && jsonEquals(existing, baselineModel)) return "apply";
			return jsonEquals(existing, op.model) ? "reached" : "conflict";
		}
		case "removeModel": {
			const provider = disk.providers[op.providerId];
			const existing = provider?.models?.some((model) => model.id === op.modelId);
			return existing ? "apply" : "reached";
		}
		case "renameModel": {
			const provider = disk.providers[op.providerId];
			const oldModel = provider?.models?.find((model) => model.id === op.oldId);
			if (!oldModel) {
				return provider?.models?.some((model) => model.id === op.newId) ? "reached" : "conflict";
			}
			if (provider?.models?.some((model) => model.id === op.newId)) return "conflict";
			const baselineModel = baseline.providers[op.providerId]?.models?.find((model) => model.id === op.oldId);
			if (baselineModel && !jsonEquals(oldModel, baselineModel)) return "conflict";
			return "apply";
		}
		case "removeProvider": {
			return op.providerId in disk.providers ? "apply" : "reached";
		}
	}
}

function opLocation(op: Op): string {
	const parts = [op.providerId];
	if ("modelId" in op && op.modelId) parts.push(op.modelId);
	if (op.kind === "renameModel") parts.push(op.oldId);
	if (op.kind === "set") parts.push(op.path.join("."));
	return parts.join(" › ");
}

function describeConflict(op: Op, disk: ModelsJsonDocument): SaveConflict {
	let external: unknown = MISSING;
	if (op.kind === "set") {
		const provider = disk.providers[op.providerId] as Record<string, unknown> | undefined;
		if (provider) {
			if (op.modelId === undefined) external = getPath(provider, op.path);
			else {
				const model = (Array.isArray(provider.models) ? provider.models : []).find(
					(entry) => (entry as Record<string, unknown>).id === op.modelId,
				) as Record<string, unknown> | undefined;
				if (model) external = getPath(model, op.path);
			}
		}
	}
	return {
		op,
		location: opLocation(op),
		external: renderValue(external),
		attempted: op.kind === "set" ? renderValue(op.value) : op.kind,
		externalRaw: external,
		externalPresent: external !== MISSING,
	};
}

/** Remove providers the ops materialized but which ended up with no keys (self-cancelled drafts). */
function pruneEmptyNewProviders(working: ModelsJsonDocument, disk: ModelsJsonDocument): void {
	for (const [providerId, provider] of Object.entries(working.providers)) {
		if (providerId in disk.providers) continue;
		if (isPlainObject(provider) && Object.keys(provider).length === 0) delete working.providers[providerId];
	}
}
