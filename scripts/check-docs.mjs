#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdownRoots = ["README.md", "CHANGELOG.md", "docs", "examples", "maintainers"];
const publishedDirectories = ["docs", "examples"];
const publishedRootFiles = new Set(["CHANGELOG.md", "LICENSE", "README.md", "npm-shrinkwrap.json", "package.json"]);
const failures = [];

const toPosix = (path) => path.split(sep).join("/");

function collectFiles(repositoryPath, predicate = () => true) {
	const absolutePath = join(root, repositoryPath);
	if (!existsSync(absolutePath)) return [];
	const stat = lstatSync(absolutePath);
	if (stat.isSymbolicLink()) {
		failures.push(`${toPosix(repositoryPath)}: symlinks are not allowed in checked documentation roots`);
		return [];
	}
	if (!stat.isDirectory()) return predicate(repositoryPath) ? [repositoryPath] : [];
	return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
		const child = join(repositoryPath, entry.name);
		if (entry.isSymbolicLink()) {
			failures.push(`${toPosix(child)}: symlinks are not allowed in checked documentation roots`);
			return [];
		}
		return entry.isDirectory() ? collectFiles(child, predicate) : entry.isFile() && predicate(child) ? [child] : [];
	});
}

function maskFencedCode(markdown) {
	const lines = markdown.split("\n");
	let fence;
	let frontmatter = lines[0]?.replace(/\r$/, "") === "---";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (frontmatter) {
			lines[index] = "";
			if (index > 0 && line.replace(/\r$/, "") === "---") frontmatter = false;
			continue;
		}
		if (fence) {
			const closing = line.match(/^(?:[ \t]*>[ \t]*)*[ \t]*(`+|~+)\s*$/);
			lines[index] = "";
			if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = undefined;
			continue;
		}
		const opening = line.match(/^(?:[ \t]*>[ \t]*)*[ \t]*(`{3,}|~{3,})/);
		if (opening) {
			fence = { character: opening[1][0], length: opening[1].length };
			lines[index] = "";
		}
	}
	return lines.join("\n");
}

function maskCode(markdown) {
	return maskFencedCode(markdown)
		.split("\n")
		.map((line) => line.replace(/(`+)([^`]|`(?!\1))*?\1/g, ""))
		.join("\n");
}

function markdownDestinations(markdown) {
	const destinations = [];
	for (let index = 0; index < markdown.length - 1; index++) {
		if (markdown[index] !== "]" || markdown[index + 1] !== "(") continue;
		let depth = 1;
		let escaped = false;
		let cursor = index + 2;
		for (; cursor < markdown.length; cursor++) {
			const character = markdown[cursor];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === "(") depth++;
			if (character === ")") depth--;
			if (depth === 0) break;
		}
		if (depth === 0) {
			destinations.push(markdown.slice(index + 2, cursor));
			index = cursor;
		}
	}
	for (const match of markdown.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
		destinations.push(match[1]);
	}
	return destinations;
}

function normalizeLinkTarget(rawTarget) {
	let target = rawTarget.trim();
	if (target.startsWith("<")) {
		const closing = target.indexOf(">");
		if (closing !== -1) target = target.slice(1, closing);
	} else {
		const titleSeparator = target.match(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/);
		if (titleSeparator?.index !== undefined) target = target.slice(0, titleSeparator.index);
	}
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

const isExternalTarget = (target) => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);

function isCaseExactPath(repositoryPath) {
	const segments = toPosix(repositoryPath).split("/").filter(Boolean);
	let directory = root;
	for (const segment of segments) {
		if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return false;
		if (!readdirSync(directory).includes(segment)) return false;
		directory = join(directory, segment);
	}
	return true;
}

function resolveLocalTarget(markdownPath, target) {
	const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
	if (!withoutFragment) return undefined;
	const absoluteTarget = resolve(root, dirname(markdownPath), withoutFragment);
	const repositoryPath = toPosix(relative(root, absoluteTarget));
	const outsideRepository = repositoryPath === ".." || repositoryPath.startsWith("../");
	return { absoluteTarget, repositoryPath, outsideRepository };
}

function isPublishedPath(repositoryPath) {
	const path = toPosix(repositoryPath);
	return publishedRootFiles.has(path) || publishedDirectories.some((d) => path === d || path.startsWith(`${d}/`));
}

function checkedMarkdown(markdownPath) {
	const markdown = readFileSync(join(root, markdownPath), "utf8");
	if (markdownPath === "CHANGELOG.md" && !markdown.includes("## [Unreleased]")) {
		failures.push("CHANGELOG.md: missing [Unreleased] section");
	}
	return maskCode(markdown);
}

const markdownFiles = markdownRoots.flatMap((path) => collectFiles(path, (file) => file.endsWith(".md"))).sort();

for (const markdownPath of markdownFiles) {
	const markdown = checkedMarkdown(markdownPath);
	const isPublishedMarkdown =
		markdownPath === "README.md" ||
		markdownPath === "CHANGELOG.md" ||
		publishedDirectories.some((path) => toPosix(markdownPath).startsWith(`${path}/`));
	for (const rawTarget of markdownDestinations(markdown)) {
		const target = normalizeLinkTarget(rawTarget);
		if (!target || isExternalTarget(target)) continue;
		const resolved = resolveLocalTarget(markdownPath, target);
		if (!resolved) continue;
		if (
			resolved.outsideRepository ||
			!existsSync(resolved.absoluteTarget) ||
			!isCaseExactPath(resolved.repositoryPath)
		) {
			failures.push(`${toPosix(markdownPath)}: local link does not exist with exact casing: ${target}`);
			continue;
		}
		if (isPublishedMarkdown && !isPublishedPath(resolved.repositoryPath)) {
			failures.push(`${toPosix(markdownPath)}: published documentation links to an unpublished path: ${target}`);
		}
	}
}

function canonicalDocsPath(path, label, { mustExist }) {
	if (typeof path !== "string" || path.length === 0) {
		failures.push(`docs/docs.json: ${label} must be a non-empty string`);
		return undefined;
	}
	if (path.includes("\\") || path.startsWith("/") || posix.normalize(path) !== path || !path.endsWith(".md")) {
		failures.push(`docs/docs.json: ${label} must be a canonical relative POSIX Markdown path: ${path}`);
		return undefined;
	}
	if (mustExist) {
		const repositoryPath = `docs/${path}`;
		const absolutePath = join(root, repositoryPath);
		if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile() || !isCaseExactPath(repositoryPath)) {
			failures.push(`docs/docs.json: ${label} does not identify an exact Markdown file: ${path}`);
		}
	}
	return path;
}

const docsNavigation = JSON.parse(readFileSync(join(root, "docs", "docs.json"), "utf8"));
if (!Array.isArray(docsNavigation.navigation)) failures.push("docs/docs.json: navigation must be an array");
if (!Array.isArray(docsNavigation.redirects)) failures.push("docs/docs.json: redirects must be an array");
const navigationPaths = [];
for (const [groupIndex, group] of (docsNavigation.navigation ?? []).entries()) {
	if (typeof group?.title !== "string" || !Array.isArray(group.items)) {
		failures.push(`docs/docs.json: navigation[${groupIndex}] must have a title and items array`);
		continue;
	}
	for (const [itemIndex, item] of group.items.entries()) {
		if (typeof item?.title !== "string") {
			failures.push(`docs/docs.json: navigation[${groupIndex}].items[${itemIndex}] must have a title`);
		}
		const path = canonicalDocsPath(item?.path, `navigation item ${item?.title ?? itemIndex}`, { mustExist: true });
		if (path) navigationPaths.push(path);
	}
}
for (const path of new Set(navigationPaths.filter((path, index) => navigationPaths.indexOf(path) !== index))) {
	failures.push(`docs/docs.json: navigation target is listed more than once: ${path}`);
}

const redirectSources = [];
for (const [redirectIndex, redirect] of (docsNavigation.redirects ?? []).entries()) {
	const from = canonicalDocsPath(redirect?.from, `redirect[${redirectIndex}].from`, { mustExist: false });
	canonicalDocsPath(redirect?.to, `redirect[${redirectIndex}].to`, { mustExist: true });
	if (from) redirectSources.push(from);
}
for (const path of new Set(redirectSources.filter((val, index) => redirectSources.indexOf(val) !== index))) {
	failures.push(`docs/docs.json: redirect source is listed more than once: ${path}`);
}

if (failures.length > 0) {
	console.error("Documentation checks failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(`Verified ${markdownFiles.length} Markdown files and ${navigationPaths.length} documentation routes.`);
