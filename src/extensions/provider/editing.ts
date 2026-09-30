/** Owns edits and refresh tracking; model handles keep persistence out of panes. */
import type { ModelsJsonModel } from "../../core/model-config.ts";
import { effectiveModelSettings, hasProviderSettings } from "./configuration.ts";
import { setPath } from "./json-fields.ts";
import type { RefreshCoordinator } from "./refresh.ts";
import type { ModelsJsonStore } from "./store.ts";

interface ModelFields {
	read(): Partial<ModelsJsonModel>;
	setField(path: readonly string[], value: unknown): void;
}

export interface DraftModelHandle extends ModelFields {
	readonly isDraft: true;
}

export interface PersistedModelHandle extends ModelFields {
	readonly isDraft: false;
	rename(newId: string): Promise<string | undefined>;
}

export type ModelHandle = DraftModelHandle | PersistedModelHandle;
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
			isDraft: true,
			read: () => fields,
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
		if (!settings.api) return "Cannot resolve an api — set one under Model-Specific API or the provider's API Auth.";
		if (!settings.baseUrl)
			return "Cannot resolve a baseUrl — set one under Model-Specific API or the provider's API Auth.";
		this.store.addModel(this.providerId, { ...fields, id });
		this.changed();
		return undefined;
	}

	model(modelId: string, onRename: (oldId: string, newId: string) => void): PersistedModelHandle {
		let id = modelId;
		let snapshot: ModelsJsonModel | undefined;
		return {
			isDraft: false,
			read: () => snapshot ?? this.store.getModel(this.providerId, id) ?? { id },
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
}
