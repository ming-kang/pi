import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { TaskRead, TaskSnapshot } from "./types.ts";

/** A panel-local view. Components own their content; the panel owns scrolling. */
export interface TaskView {
	info: Component;
	output: Component;
	update(task: TaskSnapshot, output?: TaskRead): void;
	dispose?(): void;
}

export interface TaskViewProvider {
	/** Tail views receive bounded output reads and initially follow the bottom. */
	outputMode: "tail" | "snapshot";
	create(context: { theme: Theme; requestRender(): void }): TaskView;
}

/** Session-local renderer registrations, never part of a persisted task snapshot. */
export class TaskViewRegistry {
	private readonly providers = new Map<string, TaskViewProvider>();
	private readonly listeners = new Set<() => void>();
	private closed = false;

	register(kind: string, provider: TaskViewProvider): () => void {
		if (this.closed) throw new Error("Task views are closed");
		if (this.providers.has(kind)) throw new Error(`Task view already registered: ${kind}`);
		this.providers.set(kind, provider);
		this.emit();
		return () => {
			if (this.providers.get(kind) !== provider) return;
			this.providers.delete(kind);
			this.emit();
		};
	}

	get(kind: string): TaskViewProvider | undefined {
		return this.providers.get(kind);
	}

	subscribe(listener: () => void): () => void {
		if (this.closed) return () => {};
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	close(): void {
		this.closed = true;
		this.providers.clear();
		this.emit();
		this.listeners.clear();
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* A view cannot interrupt registration or execution. */
			}
		}
	}
}
