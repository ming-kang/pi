const literal = (term) => ({ term });
const pattern = (term, expression) => ({ term, expression });

/**
 * Documentation-governance terms which cannot appear in the published
 * documentation surface. Rules deliberately describe only stale standalone
 * distribution terminology; they are not a runtime feature registry.
 */
export const STALE_TERM_RULES = Object.freeze([
	{
		id: "standalone-invalid-monorepo-path",
		messagePrefix: "a standalone-invalid ",
		messageSuffix: " path",
		terms: [
			pattern("packages/coding-agent", /packages\/coding-agent(?![\w-])/),
			pattern("packages/agent-core", /packages\/agent-core(?![\w-])/),
			pattern("packages/ai", /packages\/ai(?![\w-])/),
			pattern("packages/tui", /packages\/tui(?![\w-])/),
		],
	},
	{
		id: "legacy-package-identifier",
		messagePrefix: "a legacy package identifier: ",
		terms: [
			literal("@mariozechner/pi-coding-agent"),
			literal("@mariozechner/pi-agent-core"),
			literal("@mariozechner/pi-ai"),
			literal("@mariozechner/pi-tui"),
			pattern("pi-coding-agent", /(?<![\w@/-])pi-coding-agent(?![\w/-])/),
		],
	},
	{
		id: "legacy-monorepo-repository-identifier",
		messagePrefix: "a legacy monorepo repository identifier: ",
		terms: [literal("badlogic/pi-mono"), literal("mariozechner/pi-mono")],
	},
	{
		id: "workspace-only-metadata",
		messagePrefix: "workspace-only metadata: ",
		terms: [literal("pnpm-workspace.yaml"), pattern("workspace dependency protocol", /workspace:(?:\*|\^|~|\d)/)],
	},
	{
		id: "maintainer-only-leakage",
		messagePrefix: "maintainer-only leakage: ",
		terms: [
			literal("maintainers/upstream.json"),
			literal("npm run diff:upstream"),
			literal("upstream-extract"),
			literal("maintainers/"),
		],
	},
]);

/** The one retained historical reference in the release history. */
export const STALE_TERM_ALLOWLIST = Object.freeze([
	{
		path: "CHANGELOG.md",
		term: "maintainers/",
		text: "Repository architecture, upstream synchronization, development, and release procedures now live separately under `maintainers/` and are excluded from npm packages.",
	},
]);

function stripExternalMarkdownLinkDestinations(content) {
	const linkStart = /!?\[([^\]]*)\]\(\s*<?https?:\/\//gi;
	let result = "";
	let cursor = 0;
	let match = linkStart.exec(content);
	while (match) {
		const openingParenthesis = content.indexOf("(", match.index + match[0].indexOf("]"));
		let depth = 0;
		let closingParenthesis = -1;
		let escaped = false;
		for (let index = openingParenthesis; index < content.length; index++) {
			const character = content[index];
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
			if (depth === 0) {
				closingParenthesis = index;
				break;
			}
		}
		if (closingParenthesis !== -1) {
			result += content.slice(cursor, match.index) + match[1];
			cursor = closingParenthesis + 1;
			linkStart.lastIndex = cursor;
		}
		match = linkStart.exec(content);
	}
	return result + content.slice(cursor);
}

/**
 * Removes external URL text while retaining Markdown link labels, which are
 * reader-visible documentation and must remain subject to stale-term checks.
 */
export function stripExternalUrls(content) {
	return stripExternalMarkdownLinkDestinations(content).replace(/https?:\/\/[^\s>"']+/gi, "");
}

function matchedTerm(content, definition) {
	if (definition.expression) return content.match(definition.expression)?.[0];
	return content.includes(definition.term) ? definition.term : undefined;
}

function removeAllowedOccurrences(repositoryPath, content) {
	let checkedContent = content;
	for (const allowance of STALE_TERM_ALLOWLIST) {
		if (allowance.path === repositoryPath) checkedContent = checkedContent.replace(allowance.text, "");
	}
	return checkedContent;
}

/**
 * Returns one deterministic failure per stale-term category for a repository-
 * relative POSIX path and its unmodified file content.
 */
export function staleTermFailures(repositoryPath, content) {
	const checkedContent = removeAllowedOccurrences(repositoryPath, stripExternalUrls(content));
	const failures = [];
	for (const rule of STALE_TERM_RULES) {
		for (const definition of rule.terms) {
			const term = matchedTerm(checkedContent, definition);
			if (!term) continue;
			failures.push(`${repositoryPath}: contains ${rule.messagePrefix}${term}${rule.messageSuffix ?? ""}`);
			break;
		}
	}
	return failures;
}
