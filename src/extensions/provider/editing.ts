/** Owns edits and refresh tracking; model handles keep persistence out of panes. */
import type { ModelsJsonModel, ModelsJsonModelOverride } from "../../core/model-config.ts";
import { builtinModelFields, isBuiltinProviderId } from "./catalog.ts";
import { effectiveModelSettings, hasProviderSettings } from "./configuration.ts";
import { DELETE, getPath, isPlainObject, setPath } from "./json-fields.ts";
import type { RefreshCoordinator } from "./refresh.ts";
import type { ModelsJsonStore } from "./store.ts";

/**
 * The read/write surface of a model page. Panes render from these three views
 * and never ask which kind of model they edit: read() is what applies, own()
 * is what this models.json entry sets itself, and base() is what clearing a
 * field falls back to.
 */
export interface FieldsHandle {
	read(): Partial<ModelsJsonModel>;
	own(): ModelsJsonModelOverride;
	/** The built-in values beneath own(); undefined when nothing is inherited. */
	base(): Partial<ModelsJsonModel> | undefined;
	setField(path: readonly string[], value: unknown): void;
}

/** What the compat pages need, so provider-level compat edits through the same pages as a model's. */
export type CompatFields = Pick<FieldsHandle, "read" | "setField">;

export interface DraftModelHandle extends FieldsHandle {
	readonly kind: "draft";
}

export interface PersistedModelHandle extends FieldsHandle {
	readonly kind: "custom";
	rename(newId: string): Promise<string | undefined>;
}

/**
 * A built-in catalog model edited through `modelOverrides`: own() is the
 * override entry, base() the catalog model, and read() the two merged by the
 * runtime's own rules, so a cleared field falls back to the catalog value.
 */
export interface OverrideModelHandle extends FieldsHandle {
	readonly kind: "override";
	/** Drop the whole modelOverrides entry. */
	reset(): void;
}

export type ModelHandle = DraftModelHandle | PersistedModelHandle | OverrideModelHandle;
export type ProviderView = Pick<ModelsJsonStore, "getProvider" | "getModels" | "getModel">;

export class ProviderEdits {
	private readonly store: ModelsJsonStore;
	private readonly providerId: string;
	private readonly refresher: RefreshCoordinator;
	private readonly refresh: () => void;
	renaming = false;

	constructor(store: ModelsJsonStore, providerId: string, refresher: RefreshCoordinator, refresh: () => void) {
		this.store = store;
		this.providerId = providerId;
		this.refresher = refresher;
		this.refresh = refresh;
	}

	private changed(): void {
		if (
			!this.store.isDraftProvider(this.providerId) ||
			hasProviderSettings(this.store.getProvider(this.providerId))
		) {
			this.refresher.touch(this.providerId);
		}
		this.refresh();
	}

	setProviderField(path: readonly string[], value: unknown): void {
		this.store.setProviderField(this.providerId, path, value);
		this.changed();
	}

	removeProvider(): void {
		this.store.removeProvider(this.providerId);
		this.changed();
	}

	removeModel(modelId: string): void {
		this.store.removeModel(this.providerId, modelId);
		this.changed();
	}

	batch(apply: () => void): void {
		this.store.batch(apply);
	}

	addModels(models: readonly ModelsJsonModel[]): void {
		this.store.batch(() => {
			for (const model of models) this.store.addModel(this.providerId, model);
		});
		if (models.length > 0) this.changed();
	}

	draft(): DraftModelHandle {
		const fields: Partial<ModelsJsonModel> = {};
		return {
			kind: "draft",
			read: () => fields,
			own: () => fields,
			base: () => undefined,
			setField: (path, value) => {
				setPath(fields, path, value);
				this.refresh();
			},
		};
	}

	commitDraft(draft: DraftModelHandle): string | undefined {
		const fields = draft.read();
		const id = (fields.id ?? "").trim();
		if (!id) return "Model id is required.";
		if (this.store.getModel(this.providerId, id)) return `Model "${id}" already exists.`;
		const settings = effectiveModelSettings(this.providerId, this.store.getProvider(this.providerId), fields);
		if (!settings.api)
			return "Cannot resolve an api — set one under Model-specific API or the provider's Authentication page.";
		if (!settings.baseUrl)
			return "Cannot resolve a baseUrl — set one under Model-specific API or the provider's Authentication page.";
		this.store.addModel(this.providerId, { ...fields, id });
		this.changed();
		return undefined;
	}

	model(modelId: string, onRename: (oldId: string, newId: string) => void): PersistedModelHandle {
		let id = modelId;
		let snapshot: ModelsJsonModel | undefined;
		const read = () => snapshot ?? this.store.getModel(this.providerId, id) ?? { id };
		return {
			kind: "custom",
			read,
			own: read,
			base: () => undefined,
			setField: (path, value) => {
				this.store.setModelField(this.providerId, id, path, value);
				this.changed();
			},
			rename: async (newId) => {
				const oldId = id;
				snapshot = this.store.getModel(this.providerId, id);
				this.renaming = true;
				try {
					const error = await this.store.renameModel(this.providerId, id, newId);
					if (error) return error;
					id = newId;
					this.changed();
					return undefined;
				} finally {
					snapshot = undefined;
					this.renaming = false;
					onRename(oldId, id);
				}
			},
		};
	}

	override(modelId: string): OverrideModelHandle {
		const own = (): ModelsJsonModelOverride =>
			this.store.getProvider(this.providerId)?.modelOverrides?.[modelId] ?? {};
		// The catalog is static; one copy serves every render.
		const catalog = builtinModelFields(this.providerId, modelId) ?? { id: modelId };
		return {
			kind: "override",
			own,
			base: () => catalog,
			read: () => builtinModelFields(this.providerId, modelId, own()) ?? catalog,
			setField: (path, value) => {
				this.store.batch(() => {
					this.store.setProviderField(this.providerId, ["modelOverrides", modelId, ...path], value);
					// A cleared field must not leave `{}` shells behind: prune emptied parents up to modelOverrides.
					if (value === DELETE) this.pruneEmpty(["modelOverrides", modelId, ...path.slice(0, -1)]);
				});
				this.changed();
			},
			reset: () => {
				this.store.batch(() => {
					this.store.setProviderField(this.providerId, ["modelOverrides", modelId], DELETE);
					this.pruneEmpty(["modelOverrides"]);
				});
				this.changed();
			},
		};
	}

	/** Delete each object along `path`, deepest first, while it is empty. */
	private pruneEmpty(path: readonly string[]): void {
		for (let depth = path.length; depth > 0; depth--) {
			const prefix = path.slice(0, depth);
			const node = getPath(this.store.getProvider(this.providerId), prefix);
			if (!isPlainObject(node) || Object.keys(node).length > 0) return;
			this.store.setProviderField(this.providerId, prefix, DELETE);
		}
		// An empty built-in entry customizes nothing; drop it rather than leave `"id": {}` behind.
		const provider = this.store.getProvider(this.providerId);
		if (provider && Object.keys(provider).length === 0 && isBuiltinProviderId(this.providerId))
			this.store.removeProvider(this.providerId);
	}
}
