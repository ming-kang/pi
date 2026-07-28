#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdownRoots = ["README.md", "CHANGELOG.md", "docs", "examples", "maintainers"];
const publishedDirectories = ["docs", "examples"];
const publishedRootFiles = new Set(["CHANGELOG.md", "LICENSE", "README.md", "npm-shrinkwrap.json", "package.json"]);
const failures = [];

function toPosix(path) {
	return path.split(sep).join("/");
}

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

function decodeHtmlCodePoint(value, radix) {
	const codePoint = Number.parseInt(value, radix);
	return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
		? String.fromCodePoint(codePoint)
		: "�";
}

function decodeNamedEntity(name) {
	const named = new Map([
		["amp", "&"],
		["AMP", "&"],
		["apos", "'"],
		["gt", ">"],
		["GT", ">"],
		["lt", "<"],
		["LT", "<"],
		["nbsp", " "],
		["quot", '"'],
		["QUOT", '"'],
		["AElig", "Æ"],
		["aelig", "æ"],
		["ETH", "Ð"],
		["eth", "ð"],
		["OElig", "Œ"],
		["oelig", "œ"],
		["szlig", "ß"],
		["THORN", "Þ"],
		["thorn", "þ"],
	]);
	const direct = named.get(name);
	if (direct !== undefined) return direct;
	const accented = name.match(/^([A-Za-z])(acute|breve|caron|cedil|circ|dblac|dot|grave|macr|ogon|ring|tilde|uml)$/);
	if (!accented) return "";
	const combiningMarks = new Map([
		["acute", "\u0301"],
		["breve", "\u0306"],
		["caron", "\u030c"],
		["cedil", "\u0327"],
		["circ", "\u0302"],
		["dblac", "\u030b"],
		["dot", "\u0307"],
		["grave", "\u0300"],
		["macr", "\u0304"],
		["ogon", "\u0328"],
		["ring", "\u030a"],
		["tilde", "\u0303"],
		["uml", "\u0308"],
	]);
	return `${accented[1]}${combiningMarks.get(accented[2])}`.normalize("NFC");
}

function decodeHtmlEntities(text) {
	return text.replace(
		/&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z][\dA-Za-z]+));/g,
		(_entity, decimal, hexadecimal, name) => {
			if (decimal) return decodeHtmlCodePoint(decimal, 10);
			if (hexadecimal) return decodeHtmlCodePoint(hexadecimal, 16);
			return decodeNamedEntity(name);
		},
	);
}

function visibleHeadingText(heading) {
	return decodeHtmlEntities(
		heading
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/!?\[([^\]]*)\]\s*\[[^\]]*\]/g, "$1")
			.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1")
			.replace(/(`+)(.*?)\1/g, "$2")
			.replace(/<[^>]*>/g, ""),
	);
}

function githubHeadingSlug(heading) {
	const visibleText = visibleHeadingText(heading);
	return visibleText
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Mark}\p{Number}\p{Emoji_Modifier}\p{Join_Control}\-_ ]/gu, "")
		.replace(/ /g, "-");
}

function markdownAnchors(markdown) {
	const lines = maskFencedCode(markdown)
		.split("\n")
		.map((line) => line.replace(/\r$/, ""));
	const anchors = new Set();
	const headingSlugs = new Set();
	const nextSuffix = new Map();

	function addHeading(heading) {
		const baseSlug = githubHeadingSlug(heading);
		let slug = baseSlug;
		let suffix = nextSuffix.get(baseSlug) ?? 0;
		while (headingSlugs.has(slug)) {
			suffix++;
			slug = `${baseSlug}-${suffix}`;
		}
		nextSuffix.set(baseSlug, suffix);
		headingSlugs.add(slug);
		anchors.add(slug);
	}

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const headingMatch = line.match(/^\s{0,3}#{1,6}(?:[ \t]+|$)(.*)$/);
		if (headingMatch) {
			addHeading(headingMatch[1].replace(/[ \t]+#+[ \t]*$/, "").trim());
		} else if (index > 0 && /^\s{0,3}(?:=+|-+)\s*$/.test(line) && lines[index - 1].trim()) {
			addHeading(lines[index - 1].trim());
		}

		const withoutCodeSpans = line.replace(/(`+)(.*?)\1/g, "");
		for (const tag of withoutCodeSpans.matchAll(/<[^>]+>/g)) {
			for (const attribute of tag[0].matchAll(/\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
				const value = attribute[1] ?? attribute[2] ?? attribute[3];
				if (value) anchors.add(decodeHtmlEntities(value));
			}
		}
	}
	return anchors;
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

function isExternalTarget(target) {
	return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

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
	if (repositoryPath === ".." || repositoryPath.startsWith("../")) {
		return { absoluteTarget, repositoryPath, outsideRepository: true };
	}
	return { absoluteTarget, repositoryPath, outsideRepository: false };
}

function isPublishedPath(repositoryPath) {
	const path = toPosix(repositoryPath);
	return (
		publishedRootFiles.has(path) ||
		publishedDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`))
	);
}

function checkedMarkdown(markdownPath) {
	const markdown = readFileSync(join(root, markdownPath), "utf8");
	if (markdownPath === "CHANGELOG.md" && !markdown.includes("## [Unreleased]")) {
		failures.push("CHANGELOG.md: missing [Unreleased] section");
	}
	return maskCode(markdown);
}

const markdownFiles = markdownRoots.flatMap((path) => collectFiles(path, (file) => file.endsWith(".md"))).sort();
const anchorCache = new Map();

function anchorsFor(markdownPath) {
	let anchors = anchorCache.get(markdownPath);
	if (!anchors) {
		anchors = markdownAnchors(readFileSync(join(root, markdownPath), "utf8"));
		anchorCache.set(markdownPath, anchors);
	}
	return anchors;
}

for (const markdownPath of markdownFiles) {
	const markdown = checkedMarkdown(markdownPath);
	const isPublishedMarkdown =
		markdownPath === "README.md" ||
		markdownPath === "CHANGELOG.md" ||
		publishedDirectories.some((path) => toPosix(markdownPath).startsWith(`${path}/`));
	for (const rawTarget of markdownDestinations(markdown)) {
		const target = normalizeLinkTarget(rawTarget);
		if (!target || isExternalTarget(target)) continue;
		const hashIndex = target.indexOf("#");
		const fragment = hashIndex === -1 ? undefined : target.slice(hashIndex + 1);
		const samePage = hashIndex !== -1 && target.slice(0, hashIndex).split("?", 1)[0] === "";
		const resolved = samePage ? undefined : resolveLocalTarget(markdownPath, target);
		if (!samePage && !resolved) continue;
		if (
			resolved &&
			(resolved.outsideRepository ||
				!existsSync(resolved.absoluteTarget) ||
				!isCaseExactPath(resolved.repositoryPath))
		) {
			failures.push(`${toPosix(markdownPath)}: local link does not exist with exact casing: ${target}`);
			continue;
		}
		if (resolved && isPublishedMarkdown && !isPublishedPath(resolved.repositoryPath)) {
			failures.push(`${toPosix(markdownPath)}: published documentation links to an unpublished path: ${target}`);
		}
		const targetPath = samePage ? markdownPath : resolved?.repositoryPath;
		if (fragment && targetPath?.endsWith(".md") && !anchorsFor(targetPath).has(fragment)) {
			failures.push(`${toPosix(markdownPath)}: local Markdown fragment does not exist: ${target}`);
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
const duplicateNavigationPaths = navigationPaths.filter((path, index) => navigationPaths.indexOf(path) !== index);
for (const path of new Set(duplicateNavigationPaths)) {
	failures.push(`docs/docs.json: navigation target is listed more than once: ${path}`);
}

const redirectSources = [];
for (const [redirectIndex, redirect] of (docsNavigation.redirects ?? []).entries()) {
	const from = canonicalDocsPath(redirect?.from, `redirect[${redirectIndex}].from`, { mustExist: false });
	canonicalDocsPath(redirect?.to, `redirect[${redirectIndex}].to`, { mustExist: true });
	if (from) redirectSources.push(from);
}
for (const path of new Set(redirectSources.filter((value, index) => redirectSources.indexOf(value) !== index))) {
	failures.push(`docs/docs.json: redirect source is listed more than once: ${path}`);
}

const documentedPages = new Set(navigationPaths);
const docsMarkdown = collectFiles("docs", (file) => file.endsWith(".md")).map((file) =>
	toPosix(file).slice("docs/".length),
);
for (const path of docsMarkdown) {
	if (!documentedPages.has(path)) failures.push(`docs/docs.json: Markdown page is missing from navigation: ${path}`);
}

for (const path of ["README.md", "CHANGELOG.md", "docs", "examples"]) {
	for (const file of collectFiles(path, (entry) => /\.(?:md|ts|json)$/.test(entry))) {
		let content = readFileSync(join(root, file), "utf8");
		if (file === "CHANGELOG.md") content = checkedMarkdown(file);
		const contentWithoutExternalLinks = content
			.replace(/!?\[[^\]]*\]\(https?:\/\/[^)]+\)/g, "")
			.replace(/https?:\/\/[^\s)>"']+/g, "");
		if (contentWithoutExternalLinks.includes("packages/coding-agent")) {
			failures.push(`${toPosix(file)}: contains a standalone-invalid packages/coding-agent path`);
		}
	}
}

if (failures.length > 0) {
	console.error("Documentation checks failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(`Verified ${markdownFiles.length} Markdown files and ${navigationPaths.length} documentation routes.`);
