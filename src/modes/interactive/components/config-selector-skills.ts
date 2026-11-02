import type { DefaultPackageManager, PathMetadata } from "../../../core/package-manager.ts";
import type { PackageSource, SettingsManager, SkillInvocationOverride } from "../../../core/settings-manager.ts";
import { matchInvocation, SkillInvocationPolicy, withInvocation } from "../../../core/skill-invocation.ts";
import { resolveSkillEffectiveState, type SkillEffectiveState } from "../../../core/skills.ts";
import { theme } from "../theme/theme.ts";

type SettingsScope = "user" | "project";
type LoadOverrideState = "inherit" | "load" | "unload";
/** A project skill override. `load` is a load override without an invocation override, shown as its effective state. */
type ProjectSkillState = SkillEffectiveState | "inherit" | "load";

const PACKAGE_FILTER_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

/**
 * Store a changed package entry in its shortest form: a bare source once it filters and overrides
 * nothing, and no entry at all for a project delta (`autoload: false`) that no longer changes anything.
 */
export function collapsePackageEntry(packages: PackageSource[], index: number, scope: SettingsScope): void {
	const pkg = packages[index];
	if (typeof pkg !== "object" || pkg.skillInvocationOverrides !== undefined) return;
	if (PACKAGE_FILTER_KEYS.some((key) => pkg[key] !== undefined)) return;
	if (pkg.autoload !== false) packages[index] = pkg.source;
	else if (scope === "project") packages.splice(index, 1);
}

/** The invocation override that pins a skill state; Off and inherit leave invocation to the defaults. */
function stateInvocation(state: ProjectSkillState): SkillInvocationOverride | undefined {
	return state === "on" ? "model-and-user" : state === "user-only" ? "user-only" : undefined;
}

/** What a skill row reads from its resource item. */
export interface SkillItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	frontmatterDisableModelInvocation?: boolean;
}

/** The resource list's load state, which skill rows extend with invocation. */
export interface SkillRowHost<Item extends SkillItem> {
	writeScope(): "global" | "project";
	getProjectOverrideState(item: Item): LoadOverrideState;
	setProjectResourceOverride(item: Item, state: LoadOverrideState): boolean;
	setGlobalEnabled(item: Item, enabled: boolean): void;
	getInheritedEnabled(item: Item): boolean;
	isInheritedGlobalItem(item: Item): boolean;
}

/**
 * Skill rows of `pi config`. A skill is on, user-only or off rather than loaded or not: load state
 * stays with the resource list, and invocation goes through the shared skill invocation policy, so
 * a key names the same skill here as in skill loading.
 */
export class SkillRows<Item extends SkillItem> {
	private readonly host: SkillRowHost<Item>;
	private readonly settingsManager: SettingsManager;
	private readonly invocation: SkillInvocationPolicy;

	constructor(host: SkillRowHost<Item>, settingsManager: SettingsManager, packageManager: DefaultPackageManager) {
		this.host = host;
		this.settingsManager = settingsManager;
		this.invocation = new SkillInvocationPolicy(settingsManager, packageManager);
	}

	/** Advance the skill to its next state; returns whether it is now enabled, or undefined when nothing changed. */
	toggle(item: Item): boolean | undefined {
		if (this.host.writeScope() === "project") {
			const state = this.nextProjectState(item);
			if (!this.setProjectState(item, state)) return undefined;
			return state === "inherit" ? this.inheritedState(item) !== "off" : state !== "off";
		}
		const current = this.effectiveState(item);
		const next: SkillEffectiveState = current === "on" ? "user-only" : current === "user-only" ? "off" : "on";
		this.setGlobalState(item, next);
		return next !== "off";
	}

	checkbox(item: Item): string {
		if (this.host.writeScope() === "project") {
			const state = this.projectState(item);
			if (state === "on") return theme.fg("success", "[+]");
			if (state === "user-only") return theme.fg("accent", "[u]");
			if (state === "off") return theme.fg("warning", "[-]");
			if (state === "load") {
				const effectiveState = this.effectiveState(item);
				if (effectiveState === "user-only") return theme.fg("accent", "[u]");
				if (effectiveState === "off") return theme.fg("warning", "[-]");
				return theme.fg("success", "[+]");
			}
			const inheritedState = this.inheritedState(item);
			return theme.fg("dim", inheritedState === "on" ? "[x]" : inheritedState === "user-only" ? "[u]" : "[ ]");
		}
		const state = this.effectiveState(item);
		if (state === "on") return theme.fg("success", "[x]");
		if (state === "user-only") return theme.fg("accent", "[u]");
		return theme.fg("dim", "[ ]");
	}

	suffix(item: Item): string {
		if (this.host.writeScope() === "project") {
			const state = this.projectState(item);
			if (state === "on") return theme.fg("muted", "  project on");
			if (state === "user-only") return theme.fg("muted", "  project user only");
			if (state === "off") return theme.fg("muted", "  project off");
			if (state === "load") return theme.fg("muted", "  project load");
			return this.host.isInheritedGlobalItem(item) ? theme.fg("dim", "  inherited global") : "";
		}
		return this.effectiveState(item) === "user-only" ? theme.fg("accent", "  user only") : "";
	}

	/** A project row that only inherits its global state. */
	dimmed(item: Item): boolean {
		return (
			this.host.writeScope() === "project" &&
			this.host.isInheritedGlobalItem(item) &&
			this.projectState(item) === "inherit"
		);
	}

	/** The state settings give a skill in the current mode; global mode ignores project settings. */
	private effectiveState(item: Item): SkillEffectiveState {
		const scopes: SettingsScope[] = this.host.writeScope() === "project" ? ["project", "user"] : ["user"];
		return resolveSkillEffectiveState({
			enabled: item.enabled,
			invocationOverride: this.invocation.resolve(item.path, item.metadata, scopes),
			frontmatterDisableModelInvocation: item.frontmatterDisableModelInvocation,
		});
	}

	private inheritedState(item: Item): SkillEffectiveState {
		return resolveSkillEffectiveState({
			enabled: this.host.getInheritedEnabled(item),
			invocationOverride: this.invocation.resolve(item.path, item.metadata, ["user"]),
			frontmatterDisableModelInvocation: item.frontmatterDisableModelInvocation,
		});
	}

	/** Cycle through the states other than the inherited one, then back to inherit. */
	private nextProjectState(item: Item): Exclude<ProjectSkillState, "load"> {
		const states: SkillEffectiveState[] = ["on", "user-only", "off"];
		const inheritedIndex = states.indexOf(this.inheritedState(item));
		const sequence = [...states.slice(inheritedIndex + 1), ...states.slice(0, inheritedIndex + 1)];
		const current = this.projectState(item);
		if (current === "inherit") return sequence[0]!;
		if (current === "load") return "inherit";
		const currentIndex = sequence.indexOf(current);
		return sequence[currentIndex + 1] ?? "inherit";
	}

	private projectState(item: Item): ProjectSkillState {
		if (this.host.writeScope() !== "project") return "inherit";
		const loadState = this.host.getProjectOverrideState(item);
		if (loadState === "unload") return "off";
		const layer = this.invocation.layer("project", item.metadata);
		const invocation = layer ? matchInvocation(layer, item.path).override : undefined;
		if (invocation) return invocation === "user-only" ? "user-only" : "on";
		return loadState;
	}

	private setGlobalState(item: Item, state: SkillEffectiveState): void {
		this.host.setGlobalEnabled(item, state !== "off");
		this.setInvocationOverride(item, "user", stateInvocation(state));
	}

	private setProjectState(item: Item, state: Exclude<ProjectSkillState, "load">): boolean {
		const loadState: LoadOverrideState = state === "inherit" ? "inherit" : state === "off" ? "unload" : "load";
		if (!this.host.setProjectResourceOverride(item, loadState)) return false;
		this.setInvocationOverride(item, "project", stateInvocation(state));
		return true;
	}

	/** Runs after the load write, which creates the package entry a project override needs. */
	private setInvocationOverride(
		item: Item,
		scope: SettingsScope,
		override: SkillInvocationOverride | undefined,
	): void {
		const layer = this.invocation.layer(scope, item.metadata);
		if (!layer) return;
		const overrides = withInvocation(layer, item.path, override);
		if (item.metadata.origin === "top-level") {
			if (scope === "project") this.settingsManager.setProjectSkillInvocationOverrides(overrides);
			else this.settingsManager.setSkillInvocationOverrides(overrides);
			return;
		}

		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const packages = [...(settings.packages ?? [])];
		const pkgIndex = this.invocation.findPackage(scope, item.metadata);
		const current = packages[pkgIndex];
		if (current === undefined || (typeof current === "string" && !overrides)) return;
		packages[pkgIndex] = {
			...(typeof current === "string" ? { source: current } : current),
			skillInvocationOverrides: overrides,
		};
		collapsePackageEntry(packages, pkgIndex, scope);
		if (scope === "project") this.settingsManager.setProjectPackages(packages);
		else this.settingsManager.setPackages(packages);
	}
}
