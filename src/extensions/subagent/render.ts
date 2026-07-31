import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { getSubagentRetryView } from "./retry.ts";
import { statusSummary } from "./runner.ts";
import type { SubagentParams } from "./schema.ts";
import type { SubagentDetails, SubagentRunDetails, SubagentRunStatus } from "./types.ts";

const SINGLE_EXCERPT_LIMIT = 200;
const RUN_LINE_EXCERPT_LIMIT = 96;
const RUN_ERROR_EXCERPT_LIMIT = 200;
const RETRY_ERROR_EXCERPT_LIMIT = 160;
const LIVE_TAIL_LIMIT = 100;
const COLLAPSED_RUN_LIMIT = 4;
const PROMPT_PREVIEW_LINES = 2;
const PROMPT_PREVIEW_LINE_LIMIT = 120;
const ACTIVITY_SUMMARY_LIMIT = 96;
const ACTIVITY_RESULT_LIMIT = 64;
// Sub-10s tool calls are routine; a duration only earns ink when it
// explains where the time went.
const ACTIVITY_DURATION_MIN_MS = 10_000;
const EXPANDED_LIVE_TAIL_LINES = 3;

class IndentedText implements Component {
	private readonly text: Text;
	private readonly indent: number;

	constructor(text: string, indent: number) {
		this.text = new Text(text, 0, 0);
		this.indent = indent;
	}

	render(width: number): string[] {
		const indent = Math.min(this.indent, Math.max(0, width - 1));
		const prefix = " ".repeat(indent);
		return this.text.render(Math.max(1, width - indent)).map((line) => `${prefix}${line}`);
	}

	invalidate(): void {
		this.text.invalidate();
	}
}

// Display-only: profile names stay lowercase everywhere the model sees
// them; the transcript shows "general" as "General", "code-reviewer" as
// "Code Reviewer".
function displayAgentName(name: string): string {
	return name
		.split(/[-_]/u)
		.filter(Boolean)
		.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
		.join(" ");
}

function singleAgentName(args: { agent?: string | null }): string {
	return displayAgentName(args.agent ?? "general");
}

function truncate(text: string, limit: number): string {
	// Count code points, not UTF-16 code units: slicing a surrogate pair in
	// half would render as a lone replacement glyph in the terminal.
	const chars = [...text];
	return chars.length <= limit ? text : `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

const DUNDER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CODE_OPERATOR_SUFFIX_PATTERN = /(?:={1,3}|!={1,2}|<=?|>=?|:=|[-+*/%&|^]=?)$/u;
const CODE_OPERATOR_PREFIX_PATTERN = /^(?:={1,3}|!={1,2}|<=?|>=?|:=|[-+*/%&|^]=?)/u;
const CODE_KEYWORD_SUFFIX_PATTERN = /\b(?:return|yield|raise|del|global|nonlocal|import|from|as)\s*$/u;

// Double underscores are ambiguous: Markdown uses them for strong emphasis,
// while code uses them for dunder identifiers. Preserve identifier-shaped
// spans in clear code contexts and strip the remaining emphasis markers.
function stripUnderscoreStrong(text: string): string {
	return text.replace(/__([^_\n]+)__/gu, (match: string, content: string, offset: number) => {
		const before = text[offset - 1] ?? "";
		const after = text[offset + match.length] ?? "";
		const pairedCodeDelimiter =
			(before === "`" && after === "`") || (before === '"' && after === '"') || (before === "'" && after === "'");
		const codeAdjacent = before === "." || after === "(" || after === "." || after === "[";
		const trimmedBefore = text.slice(0, offset).trimEnd();
		const trimmedAfter = text.slice(offset + match.length).trimStart();
		const operatorAdjacent =
			CODE_OPERATOR_SUFFIX_PATTERN.test(trimmedBefore) || CODE_OPERATOR_PREFIX_PATTERN.test(trimmedAfter);
		const keywordAdjacent = CODE_KEYWORD_SUFFIX_PATTERN.test(trimmedBefore);
		return DUNDER_IDENTIFIER_PATTERN.test(content) &&
			(pairedCodeDelimiter || codeAdjacent || operatorAdjacent || keywordAdjacent)
			? match
			: content;
	});
}

// Transcript excerpts render inside plain Text components, so markdown
// punctuation would show up literally; strip the common inline syntax.
function stripInlineMarkdown(text: string): string {
	return (
		stripUnderscoreStrong(text.replace(/```[a-zA-Z0-9-]*/gu, ""))
			.replace(/`([^`]*)`/gu, "$1")
			// Demarcated bold only: `x**2**` is exponentiation, not emphasis.
			.replace(/(?<![A-Za-z0-9])\*\*([^*]+)\*\*(?![A-Za-z0-9])/gu, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
			.replace(/^#{1,6}\s+/gmu, "")
	);
}

// Markdown tables and horizontal rules turn into symbol soup when
// flattened onto one line; drop those lines before inline stripping.
function stripBlockMarkdown(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("|")) return false;
			return !(trimmed.length >= 3 && /^[-—─═=*_|:\s]+$/u.test(trimmed));
		})
		.join("\n");
}

// finalOutput/liveText carry model-facing truncation notices from
// boundText/tailText. Only recognize their exact boundary lines so literal
// discussion of the marker remains visible in the transcript.
const OUTPUT_TRUNCATION_NOTICE_PATTERN = /^\[Output truncated(?:: \d+ bytes omitted)?\.\]$/u;
const EARLIER_OUTPUT_NOTICE = "[Earlier output omitted.]";

function terminalOutputNotice(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	let index = lines.length - 1;
	while (index >= 0 && !lines[index]?.trim()) index--;
	if (index < 0 || !OUTPUT_TRUNCATION_NOTICE_PATTERN.test(lines[index]?.trim() ?? "")) {
		return { text, truncated: false };
	}
	lines.splice(index, 1);
	return { text: lines.join("\n").trimEnd(), truncated: true };
}

function replaceBoundaryNotices(text: string): string {
	const lines = text.split("\n");
	const first = lines.findIndex((line) => Boolean(line.trim()));
	if (first >= 0 && lines[first]?.trim() === EARLIER_OUTPUT_NOTICE) lines[first] = "…";
	let last = lines.length - 1;
	while (last >= 0 && !lines[last]?.trim()) last--;
	if (last >= 0 && OUTPUT_TRUNCATION_NOTICE_PATTERN.test(lines[last]?.trim() ?? "")) lines[last] = "…";
	return lines.join("\n");
}

function plainExcerpt(text: string, limit: number): string {
	return truncate(stripInlineMarkdown(stripBlockMarkdown(text)).replace(/\s+/gu, " ").trim(), limit);
}

function excerpt(text: string, limit: number): string {
	return plainExcerpt(replaceBoundaryNotices(text), limit);
}

// Generated notice-only boundary lines must never become the live line the
// user watches; identical text in the body remains ordinary model output.
function liveTailLines(run: SubagentRunDetails): string[] {
	const { text } = terminalOutputNotice(run.liveText);
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines[0] === EARLIER_OUTPUT_NOTICE) lines.shift();
	return lines;
}

function liveTail(run: SubagentRunDetails): string | undefined {
	const last = liveTailLines(run).at(-1);
	return last ? excerpt(last, LIVE_TAIL_LIMIT) : undefined;
}

// Completed-run excerpts read better cut at a sentence boundary than
// mid-word; fall back to a hard truncate when no boundary lands in the
// second half of the window.
function leadingSentences(text: string, limit: number): string {
	const cleaned = excerpt(text, Number.MAX_SAFE_INTEGER);
	if (cleaned.length <= limit) return cleaned;
	const window = cleaned.slice(0, limit);
	let boundary = -1;
	for (const match of window.matchAll(/[.!?。！？](?=\s|$)/gu)) {
		boundary = (match.index ?? 0) + match[0].length;
	}
	if (boundary >= limit / 2) return window.slice(0, boundary).trimEnd();
	return truncate(cleaned, limit);
}

const VERIFY_COMMAND_PATTERN = /\b(test|lint|typecheck|tsc|vitest|jest|pytest|build|check|fmt|format|compile)\b/iu;
const INSPECT_COMMAND_PATTERN = /\b(rg|grep|find|git (?:diff|status|log|show)|ls|tree|cat|head|tail)\b/iu;
const RETRY_MARKER_PATTERN = /^Retrying\b/u;
const STREAM_MARKERS = new Set(["Thinking…", "Writing response…"]);

function retryText(run: SubagentRunDetails): string | undefined {
	const retry = getSubagentRetryView(run);
	if (!retry) return undefined;
	const status =
		retry.remainingSeconds > 0
			? `Retrying (${retry.attempt}/${retry.maxAttempts}) in ${retry.remainingSeconds}s`
			: `Retrying now… (${retry.attempt}/${retry.maxAttempts})`;
	const error = excerpt(retry.error, RETRY_ERROR_EXCERPT_LIMIT);
	return error ? `${status} — ${error}` : status;
}

// Translates raw tool traffic into what the worker is doing right now, so
// the collapsed card reads as a phase instead of a command line. Modelled
// on tool-type classification; the raw tool summary stays as evidence on
// the next line.
function runIntent(run: SubagentRunDetails): string {
	const retry = retryText(run);
	if (retry) return retry;
	const current = run.currentActivity;
	if (current && RETRY_MARKER_PATTERN.test(current)) return current;
	const running = [...run.activities].reverse().find((activity) => activity.status === "running");
	if (running) {
		if (running.toolName === "edit" || running.toolName === "write") return "Applying changes";
		if (running.toolName === "bash") {
			if (VERIFY_COMMAND_PATTERN.test(running.summary)) return "Verifying changes";
			return INSPECT_COMMAND_PATTERN.test(running.summary) ? "Exploring code" : "Running commands";
		}
		return "Exploring code";
	}
	const recent = run.activities.slice(-5);
	if (current && STREAM_MARKERS.has(current)) {
		if (recent.some((activity) => activity.status === "failed")) return "Investigating a failure";
		return current;
	}
	if (recent.some((activity) => activity.status === "failed")) return "Investigating a failure";
	if (recent.some((activity) => activity.toolName === "edit" || activity.toolName === "write"))
		return "Reviewing changes";
	if (recent.length > 0) return "Exploring code";
	return current ?? "Thinking…";
}

// The raw tool summary backs up the intent line; suppress it when it would
// just repeat a stream/retry marker.
function runEvidence(run: SubagentRunDetails): string | undefined {
	if (getSubagentRetryView(run)) return undefined;
	const current = run.currentActivity;
	if (!current || STREAM_MARKERS.has(current) || RETRY_MARKER_PATTERN.test(current)) return undefined;
	return current;
}

function liveElapsed(run: SubagentRunDetails): string | undefined {
	if (run.startedAt === undefined) return undefined;
	const end = run.endedAt ?? Date.now();
	return formatDuration(Math.max(0, (end - run.startedAt) / 1000));
}

function statusColor(status: SubagentRunStatus): "success" | "error" | "warning" | "accent" | "muted" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "aborted":
			return "warning";
		case "running":
			return "accent";
		default:
			return "muted";
	}
}

// The tool shell already paints a call-level status dot (● in
// warning/success/error), so `●` is off-limits here: `›` marks where the
// work currently is, and the remaining glyphs are terminal states.
function statusMarker(status: SubagentRunStatus, theme: Theme): string {
	const glyph =
		status === "completed"
			? "✓"
			: status === "failed"
				? "×"
				: status === "aborted"
					? "■"
					: status === "running"
						? "›"
						: "○";
	return theme.fg(statusColor(status), glyph);
}

function statusWord(status: SubagentRunStatus): string {
	switch (status) {
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "aborted":
			return "Aborted";
		case "running":
			return "Running";
		default:
			return "Queued";
	}
}

function runTitle(run: SubagentRunDetails, theme: Theme, index?: number): string {
	const number = index === undefined ? "" : theme.fg("dim", `${index} · `);
	return `${statusMarker(run.status, theme)} ${number}${theme.fg("accent", displayAgentName(run.agent))}${theme.fg("dim", ` · ${truncate(run.description, 48)}`)}`;
}

// Mid-run token totals are cache-inflated (totalTokens sums cache reads
// across turns), so live lines quote tool uses and the context watermark
// instead; settled lines get the real total.
function runProgressText(run: SubagentRunDetails): string {
	const items = [`${run.usage.toolUses} tool use${run.usage.toolUses === 1 ? "" : "s"}`];
	if (run.usage.contextTokens) items.push(`ctx: ${formatTokens(run.usage.contextTokens)}`);
	return items.join(" · ");
}

function runLine(run: SubagentRunDetails, theme: Theme, index?: number): string {
	let line = runTitle(run, theme, index);
	const retry = retryText(run);
	const detail =
		retry ??
		(run.status === "running"
			? excerpt(runIntent(run), LIVE_TAIL_LIMIT)
			: run.status === "failed" || run.status === "aborted"
				? undefined
				: run.finalOutput && leadingSentences(run.finalOutput, RUN_LINE_EXCERPT_LIMIT));
	if (detail) line += theme.fg("dim", ` — ${detail}`);
	if (run.status === "running") {
		line += theme.fg("dim", ` · ${runProgressText(run)}`);
		if (run.usage.cost) line += theme.fg("dim", ` · $${run.usage.cost.toFixed(3)}`);
		const elapsed = liveElapsed(run);
		if (elapsed) line += theme.fg("dim", ` · ${elapsed}`);
	}
	const settled = run.status !== "running" && run.status !== "queued";
	if (settled && run.startedAt !== undefined && run.endedAt !== undefined) {
		line += theme.fg("dim", ` · ${formatDuration(Math.max(0, (run.endedAt - run.startedAt) / 1000))}`);
	}
	return line;
}

function runErrorExcerpt(run: SubagentRunDetails): string | undefined {
	if ((run.status !== "failed" && run.status !== "aborted") || !run.error) return undefined;
	return leadingSentences(run.error, RUN_ERROR_EXCERPT_LIMIT);
}

function runErrorIndent(index?: number): number {
	return index === undefined ? 2 : 5 + String(index).length;
}

function addRunSummary(container: Container, run: SubagentRunDetails, theme: Theme, index?: number): void {
	container.addChild(new Text(runLine(run, theme, index), 0, 0));
	const error = runErrorExcerpt(run);
	if (error) container.addChild(new IndentedText(theme.fg("error", error), runErrorIndent(index)));
}

// Keep active work visible while a batch is in flight: completed runs
// may otherwise crowd a still-running task out of the collapsed window.
function selectCollapsedRuns(runs: SubagentRunDetails[], isPartial: boolean): SubagentRunDetails[] {
	if (runs.length <= COLLAPSED_RUN_LIMIT) return runs;
	if (!isPartial) return runs.slice(0, COLLAPSED_RUN_LIMIT);
	const active = runs.filter((run) => run.status === "running" || run.status === "queued");
	const retrying = active.filter((run) => getSubagentRetryView(run));
	const retryingSet = new Set(retrying);
	const otherActive = active.filter((run) => !retryingSet.has(run));
	const settled = runs.filter((run) => run.status !== "running" && run.status !== "queued");
	return [...retrying, ...otherActive, ...settled].slice(0, COLLAPSED_RUN_LIMIT);
}

function singleCollapsedLines(details: SubagentDetails, theme: Theme): string[] {
	const run = details.runs[0];
	if (!run) return [theme.fg("muted", "Initializing…")];
	if (run.status === "running" || run.status === "queued") {
		const retry = retryText(run);
		const isInitializing =
			run.status === "running" &&
			!retry &&
			run.usage.turns === 0 &&
			run.usage.toolUses === 0 &&
			run.liveText.length === 0;
		const rawIntent =
			retry ??
			(run.status === "queued"
				? (run.currentActivity ?? statusWord(run.status))
				: isInitializing
					? "Initializing…"
					: runIntent(run));
		const intent = excerpt(rawIntent, LIVE_TAIL_LIMIT);
		// No status marker here: the shell's call-level dot already covers
		// the whole card, and a single run has nothing to disambiguate.
		let status = theme.fg("dim", intent);
		if (run.status === "running" && !isInitializing) {
			status += theme.fg("dim", ` · ${runProgressText(run)}`);
			if (run.usage.cost) status += theme.fg("dim", ` · $${run.usage.cost.toFixed(3)}`);
			const elapsed = liveElapsed(run);
			if (elapsed) status += theme.fg("dim", ` · ${elapsed}`);
		}
		const lines = [status];
		const evidence = runEvidence(run);
		if (evidence && evidence !== rawIntent)
			lines.push(`${theme.fg("accent", "›")} ${theme.fg("dim", excerpt(evidence, LIVE_TAIL_LIMIT))}`);
		const tail = liveTail(run);
		if (tail) lines.push(theme.fg("dim", tail));
		return lines;
	}
	if (run.error) return [theme.fg("error", excerpt(run.error, SINGLE_EXCERPT_LIMIT))];
	if (run.finalOutput) return [theme.fg("toolOutput", leadingSentences(run.finalOutput, SINGLE_EXCERPT_LIMIT))];
	return [theme.fg("muted", statusWord(run.status))];
}

// Deep-trimmed settled footer: turns and per-run breakdowns belong to the
// expanded view. Parallel batches keep only whole-call numbers — the run
// rows above already localize the work.
function collapsedUsageText(details: SubagentDetails, extended: boolean): string {
	const usage = details.usage;
	const items: string[] = [];
	if (usage.totalTokens) items.push(`${formatTokens(usage.totalTokens)} tok`);
	if (extended && usage.toolUses) items.push(`${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`);
	if (extended && usage.contextTokens) items.push(`ctx: ${formatTokens(usage.contextTokens)}`);
	if (usage.cost) items.push(`$${usage.cost.toFixed(3)}`);
	if (details.endedAt !== undefined) {
		items.push(formatDuration(Math.max(0, (details.endedAt - details.startedAt) / 1000)));
	}
	return items.join(" · ");
}

function batchUsageText(details: SubagentDetails, isPartial: boolean): string {
	const usage = details.usage;
	const items: string[] = [];
	// The aggregate mixes settled and running runs while partial, and the
	// running share is cache-inflated — quote the total only once settled.
	if (!isPartial && usage.totalTokens) items.push(`${formatTokens(usage.totalTokens)} tok`);
	if (usage.toolUses) items.push(`${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`);
	if (usage.turns) items.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.contextTokens) items.push(`ctx: ${formatTokens(usage.contextTokens)}`);
	if (usage.cost) items.push(`$${usage.cost.toFixed(3)}`);
	if (details.endedAt !== undefined) {
		items.push(formatDuration(Math.max(0, (details.endedAt - details.startedAt) / 1000)));
	}
	return items.join(" · ");
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatDuration(seconds: number): string {
	const roundedSeconds = Math.round(seconds);
	if (roundedSeconds >= 60) return `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;
	return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function runDurationText(run: SubagentRunDetails): string | undefined {
	if (run.startedAt === undefined || run.endedAt === undefined) return undefined;
	return formatDuration(Math.max(0, (run.endedAt - run.startedAt) / 1000));
}

// One dim line per run: what it cost. Settled runs quote the real token
// total; running runs skip it (cache-inflated mid-run) and tick elapsed
// time instead. Batch sections fold model/thinking/cwd in here because
// their `──` header already carries verdict and duration.
function runMetricsText(run: SubagentRunDetails, includeIdentity: boolean): string {
	const usage = run.usage;
	const settled = run.status !== "running" && run.status !== "queued";
	const items: string[] = [];
	if (includeIdentity) {
		items.push(run.model);
		if (run.thinking !== "off") items.push(run.thinking);
		if (run.cwd) items.push(`cwd: ${run.cwd}`);
	}
	if (settled && usage.totalTokens) items.push(`${formatTokens(usage.totalTokens)} tok`);
	if (usage.toolUses) items.push(`${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`);
	if (usage.turns) items.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.contextTokens) items.push(`ctx: ${formatTokens(usage.contextTokens)}`);
	if (usage.cost) items.push(`$${usage.cost.toFixed(3)}`);
	const duration = settled ? (includeIdentity ? undefined : runDurationText(run)) : liveElapsed(run);
	if (duration) items.push(duration);
	return items.join(" · ");
}

// The details prompt is a 1KB bounded copy of the briefing; the preview
// shows the first content lines (blank lines carry nothing at two lines
// of budget) and never pretends to more fidelity than that.
function promptSection(run: SubagentRunDetails, theme: Theme): string[] {
	const boundedPrompt = terminalOutputNotice(run.prompt);
	const lines = boundedPrompt.text
		.split("\n")
		.map((line) => plainExcerpt(line.trim(), Number.MAX_SAFE_INTEGER))
		.filter(Boolean);
	const shown = lines.slice(0, PROMPT_PREVIEW_LINES);
	const preview = shown.map((line) => theme.fg("dim", truncate(line, PROMPT_PREVIEW_LINE_LIMIT)));
	// A one-line briefing clipped mid-sentence must still say it continues.
	const clipped = shown.some((line) => line.length > PROMPT_PREVIEW_LINE_LIMIT);
	const remaining = lines.length - shown.length;
	const capped = boundedPrompt.truncated;
	const section = [theme.fg("muted", "Prompt"), ...preview];
	if (remaining > 0 || capped || clipped) {
		let note = "… continues";
		if (remaining > 0) note += `, ${remaining} more line${remaining === 1 ? "" : "s"}`;
		if (capped) note += " · capped at 1KB";
		section.push(theme.fg("muted", note));
	}
	return section;
}

// Each run expands into a report cover sheet: verdict and cost up top, a
// bounded Prompt/Activity digest in the middle, then the full Report —
// the one unbounded element, placed last so the card ends where reading
// begins. Single runs skip the `──` header (the call header already names
// them); batch sections carry a numbered header matching the contents
// list above.
function renderRunDetails(run: SubagentRunDetails, theme: Theme, single: boolean, index?: number): Component {
	const container = new Container();
	const settled = run.status !== "running" && run.status !== "queued";
	if (single) {
		const identity = [run.model];
		if (run.thinking !== "off") identity.push(`${run.thinking} thinking`);
		if (run.cwd) identity.push(`cwd: ${run.cwd}`);
		container.addChild(
			new Text(
				`${statusMarker(run.status, theme)} ${theme.fg(statusColor(run.status), statusWord(run.status))}${theme.fg("dim", ` · ${identity.join(" · ")}`)}`,
				0,
				0,
			),
		);
	} else {
		const label = index === undefined ? "" : `${index} · `;
		const duration = settled ? runDurationText(run) : undefined;
		container.addChild(
			new Text(
				`${theme.fg("dim", `── ${label}`)}${statusMarker(run.status, theme)} ${theme.fg("accent", displayAgentName(run.agent))}${theme.fg("dim", ` · ${truncate(run.description, 48)}`)}${duration ? theme.fg("dim", ` · ${duration}`) : ""}`,
				0,
				0,
			),
		);
	}
	if (run.status !== "queued") {
		const metrics = runMetricsText(run, !single);
		if (metrics) container.addChild(new Text(theme.fg("dim", metrics), 0, 0));
	}
	const retry = retryText(run);
	if (retry) container.addChild(new Text(theme.fg("accent", retry), 0, 0));
	container.addChild(new Spacer(1));
	for (const line of promptSection(run, theme)) container.addChild(new Text(line, 0, 0));
	if (run.activities.length > 0) {
		container.addChild(new Spacer(1));
		const total = run.usage.toolUses;
		const label = total > run.activities.length ? `Activity · last ${run.activities.length} of ${total}` : "Activity";
		container.addChild(new Text(theme.fg("muted", label), 0, 0));
		for (const activity of run.activities) {
			// Deviation earns ink: × and › are marked, success rows are quiet
			// one-liners without result echoes.
			let text: string;
			if (activity.status === "failed") {
				text = `${theme.fg("error", "×")} ${theme.fg("toolOutput", excerpt(activity.summary, ACTIVITY_SUMMARY_LIMIT))}`;
				if (activity.resultSummary) {
					text += ` ${theme.fg("error", `· ${excerpt(activity.resultSummary, ACTIVITY_RESULT_LIMIT)}`)}`;
				}
			} else if (activity.status === "running") {
				text = `${theme.fg("accent", "›")} ${theme.fg("toolOutput", excerpt(activity.summary, ACTIVITY_SUMMARY_LIMIT))}`;
			} else {
				text = `  ${theme.fg("toolOutput", excerpt(activity.summary, ACTIVITY_SUMMARY_LIMIT))}`;
			}
			if (activity.endedAt !== undefined && activity.endedAt - activity.startedAt >= ACTIVITY_DURATION_MIN_MS) {
				text += ` ${theme.fg("dim", `· ${formatDuration((activity.endedAt - activity.startedAt) / 1000)}`)}`;
			}
			container.addChild(new Text(text, 0, 0));
		}
	}
	// The live tail is the "now" end of the timeline; once the run settles,
	// Report takes this slot without moving anything above it.
	if (run.status === "running" && run.liveText) {
		const tail = liveTailLines(run).slice(-EXPANDED_LIVE_TAIL_LINES);
		if (tail.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Working"), 0, 0));
			for (const line of tail) {
				container.addChild(new Text(theme.fg("dim", excerpt(line, LIVE_TAIL_LIMIT)), 0, 0));
			}
		}
	}
	if (run.error) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Error"), 0, 0));
		container.addChild(new Text(theme.fg("error", run.error), 0, 0));
	}
	if (run.finalOutput) {
		container.addChild(new Spacer(1));
		const label = settled && run.status !== "completed" ? "Report · partial" : "Report";
		container.addChild(new Text(theme.fg("muted", label), 0, 0));
		container.addChild(
			new Markdown(run.finalOutput, 0, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("toolOutput", text),
			}),
		);
	}
	return container;
}

// The call header stays a single line: run rows in the result area take
// over within the first update and carry richer per-task state, so a
// task list here would render everything twice. The task count alone
// distinguishes a batch from a single delegation.
export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
	const modes = [args.prompt != null && "prompt", args.tasks != null && "tasks"].filter((mode): mode is string =>
		Boolean(mode),
	);
	if (modes.length > 1) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("Subagent "))}${theme.fg("error", `invalid · ${modes.join(" + ")}`)}`,
			0,
			0,
		);
	}
	if (args.tasks) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("Multi-Agent"))}${theme.fg("dim", ` · ${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}`)}`,
			0,
			0,
		);
	}
	let text = theme.fg("toolTitle", theme.bold(`${singleAgentName(args)} Agent`));
	if (args.description) text += theme.fg("dim", ` · ${truncate(args.description, 72)}`);
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): Component {
	const details = result.details;
	if (!details) {
		const text = result.content.find((part) => part.type === "text");
		const label = text?.type === "text" ? text.text : "(no output)";
		return new Text(theme.fg(isError ? "error" : "muted", label), 0, 0);
	}
	// The pre-resolution first paint carries no runs yet, in either mode.
	if (details.runs.length === 0) {
		return new Text(theme.fg("muted", "Initializing…"), 0, 0);
	}
	if (!options.expanded) {
		if (details.mode === "single") {
			const lines = singleCollapsedLines(details, theme);
			if (!options.isPartial) {
				const usage = collapsedUsageText(details, true);
				if (usage) lines.push(theme.fg("dim", usage));
				lines.push(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`));
			}
			return new Text(lines.join("\n"), 0, 0);
		}

		const container = new Container();
		let header = statusSummary(details);
		if (options.isPartial) {
			header += ` · ${formatDuration(Math.max(0, (Date.now() - details.startedAt) / 1000))}`;
		}
		container.addChild(new Text(theme.fg(isError ? "error" : options.isPartial ? "accent" : "muted", header), 0, 0));
		const shown = selectCollapsedRuns(details.runs, Boolean(options.isPartial));
		// Stable ordinals (the run's task position, not its display slot)
		// keep identity readable while active-first ordering reshuffles
		// rows, and match the expanded section numbers.
		for (const run of shown) addRunSummary(container, run, theme, details.runs.indexOf(run) + 1);
		const hidden = details.runs.length - shown.length;
		if (hidden > 0) container.addChild(new Text(theme.fg("muted", `+${hidden} more`), 0, 0));
		if (!options.isPartial) {
			const usage = collapsedUsageText(details, false);
			if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			container.addChild(new Text(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`), 0, 0));
		}
		return container;
	}
	const container = new Container();
	const single = details.mode === "single" && details.runs.length === 1;
	if (!single) {
		container.addChild(new Text(theme.fg(isError ? "error" : "toolTitle", statusSummary(details)), 0, 0));
		// Numbered table of contents: the TUI cannot jump, but matching the
		// numbers against the `──` section headers below makes an 8-run
		// batch navigable by eye.
		details.runs.forEach((run, index) => {
			addRunSummary(container, run, theme, index + 1);
		});
	}
	details.runs.forEach((run, index) => {
		if (!single || index > 0) container.addChild(new Spacer(1));
		container.addChild(renderRunDetails(run, theme, single, single ? undefined : index + 1));
	});
	if (!single) {
		const usage = batchUsageText(details, Boolean(options.isPartial));
		if (usage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usage), 0, 0));
		}
	}
	return container;
}
