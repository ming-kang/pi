import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalizePath, normalizePath } from "../utils/paths.ts";
import type { DefaultPackageManager, PathMetadata } from "./package-manager.ts";
import type {
	PackageSource,
	Settings,
	SettingsManager,
	SkillInvocationOverride,
	SkillInvocationOverrides,
} from "./settings-manager.ts";

/** Settings scope that declares an invocation override. */
export type InvocationScope = "user" | "project";

/** Where a skill came from; `PathMetadata` and `SourceInfo` both carry it. */
export type SkillOrigin = Pick<PathMetadata, "source" | "scope" | "origin" | "baseDir">;

/** One `skillInvocationOverrides` map and the directories its relative keys resolve against. */
export interface InvocationLayer {
	overrides: SkillInvocationOverrides | undefined;
	roots: readonly string[];
}

/** The override a layer gives one skill, and every key in the layer that names that skill. */
export interface InvocationMatch {
	override?: SkillInvocationOverride;
	keys: string[];
}

const ALL_SCOPES: readonly InvocationScope[] = ["project", "user"];

function isInvocationOverride(value: unknown): value is SkillInvocationOverride {
	return value === "model-and-user" || value === "user-only";
}

function keyTargets(key: string, roots: readonly string[]): string[] {
	const path = normalizePath(key, { trim: true });
	if (isAbsolute(path)) return [canonicalizePath(resolve(path))];
	return roots.map((root) => canonicalizePath(resolve(root, path)));
}

/** Key for a new override: relative to the first root that contains the skill, otherwise absolute. */
function invocationKey(roots: readonly string[], skillFile: string): string {
	for (const root of roots) {
		const path = relative(root, skillFile);
		if (path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return path;
	}
	return skillFile;
}

/**
 * Find the keys of `layer` that name `skillFile`: the file itself, or the directory of a `SKILL.md`.
 * A file key beats a directory key; among equals the later key wins.
 */
export function matchInvocation(layer: InvocationLayer, skillFile: string): InvocationMatch {
	const file = canonicalizePath(resolve(skillFile));
	const dir = basename(file) === "SKILL.md" ? dirname(file) : undefined;
	const keys: string[] = [];
	let fileOverride: SkillInvocationOverride | undefined;
	let dirOverride: SkillInvocationOverride | undefined;
	for (const [key, value] of Object.entries(layer.overrides ?? {})) {
		const targets = keyTargets(key, layer.roots);
		const namesFile = targets.includes(file);
		if (!namesFile && (dir === undefined || !targets.includes(dir))) continue;
		keys.push(key);
		if (!isInvocationOverride(value)) continue;
		if (namesFile) fileOverride = value;
		else dirOverride = value;
	}
	return { override: fileOverride ?? dirOverride, keys };
}

/** `layer`'s overrides with every key naming `skillFile` replaced by one key, or removed to inherit. */
export function withInvocation(
	layer: InvocationLayer,
	skillFile: string,
	override: SkillInvocationOverride | undefined,
): SkillInvocationOverrides | undefined {
	const next: SkillInvocationOverrides = { ...layer.overrides };
	for (const key of matchInvocation(layer, skillFile).keys) delete next[key];
	if (override) next[invocationKey(layer.roots, skillFile)] = override;
	return Object.keys(next).length > 0 ? next : undefined;
}

function isPackageDelta(entry: PackageSource | undefined): boolean {
	return typeof entry === "object" && entry.autoload === false;
}

/**
 * Layered skill invocation settings, shared by skill loading and `pi config` so a key names the same skill
 * everywhere. Relative top-level keys resolve against the directories of the settings file that declares
 * them, package keys against the package root. Project settings beat global ones, and package entries
 * match by package identity, as package loading does.
 */
export class SkillInvocationPolicy {
	private readonly settings: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings" | "isProjectTrusted">;
	private readonly packages: Pick<DefaultPackageManager, "getPackageIdentity" | "getTopLevelBaseDirs">;
	private readonly rootsByScope = new Map<InvocationScope, readonly string[]>();

	constructor(settings: SkillInvocationPolicy["settings"], packages: SkillInvocationPolicy["packages"]) {
		this.settings = settings;
		this.packages = packages;
	}

	/** The override that applies to a skill. Pass `["user"]` for what project settings inherit. */
	resolve(
		skillFile: string,
		origin: SkillOrigin | undefined,
		scopes: readonly InvocationScope[] = ALL_SCOPES,
	): SkillInvocationOverride | undefined {
		for (const layer of this.layers(origin, scopes)) {
			const { override } = matchInvocation(layer, skillFile);
			if (override) return override;
		}
		return undefined;
	}

	/** The layer `scope` keeps a skill's override in; undefined when that scope has no entry for its package. */
	layer(scope: InvocationScope, origin: SkillOrigin | undefined): InvocationLayer | undefined {
		if (scope === "project" && !this.settings.isProjectTrusted()) return undefined;
		if (origin?.origin !== "package") {
			return { overrides: this.settingsFor(scope).skillInvocationOverrides, roots: this.topLevelRoots(scope) };
		}
		const entry = this.packageEntry(scope, origin);
		if (entry === undefined) return undefined;
		return {
			overrides: typeof entry === "object" ? entry.skillInvocationOverrides : undefined,
			roots: origin.baseDir ? [origin.baseDir] : [],
		};
	}

	/** Index of the entry `scope` keeps for a package skill's source, or -1. */
	findPackage(scope: InvocationScope, origin: SkillOrigin): number {
		if (scope === "project" && !this.settings.isProjectTrusted()) return -1;
		const identity = this.packages.getPackageIdentity(
			origin.source,
			origin.scope === "project" && this.settings.isProjectTrusted() ? "project" : "user",
		);
		return (this.settingsFor(scope).packages ?? []).findIndex(
			(pkg) => this.packages.getPackageIdentity(typeof pkg === "string" ? pkg : pkg.source, scope) === identity,
		);
	}

	private layers(origin: SkillOrigin | undefined, scopes: readonly InvocationScope[]): InvocationLayer[] {
		const project = scopes.includes("project") ? this.layer("project", origin) : undefined;
		const user = scopes.includes("user") ? this.layer("user", origin) : undefined;
		if (!project) return user ? [user] : [];
		// A project package entry replaces the global one unless it is an autoload-disabled delta over it.
		if (origin?.origin === "package" && !isPackageDelta(this.packageEntry("project", origin))) return [project];
		return user ? [project, user] : [project];
	}

	private packageEntry(scope: InvocationScope, origin: SkillOrigin): PackageSource | undefined {
		const index = this.findPackage(scope, origin);
		return index === -1 ? undefined : this.settingsFor(scope).packages?.[index];
	}

	private settingsFor(scope: InvocationScope): Settings {
		return scope === "project" ? this.settings.getProjectSettings() : this.settings.getGlobalSettings();
	}

	private topLevelRoots(scope: InvocationScope): readonly string[] {
		let roots = this.rootsByScope.get(scope);
		if (!roots) {
			roots = this.packages.getTopLevelBaseDirs(scope);
			this.rootsByScope.set(scope, roots);
		}
		return roots;
	}
}
