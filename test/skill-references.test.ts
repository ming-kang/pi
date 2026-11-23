import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	CombinedAutocompleteProvider,
	Container,
	type SlashCommand,
	setKeybindings,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSkillBlocks } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createSkillAutocompleteProvider } from "../src/modes/interactive/skill-autocomplete.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function createEditorWithSkills(
	skillCommands: SlashCommand[],
	options?: { basePath?: string; keybindings?: KeybindingsManager },
) {
	const keybindings = options?.keybindings ?? new KeybindingsManager();
	setKeybindings(keybindings);
	const terminal = new VirtualTerminal();
	const editor = new CustomEditor(new TuiMainScreen(terminal), getEditorTheme(), keybindings);
	const builtinCommands: SlashCommand[] = [
		{ name: "model", description: "Switch model" },
		{ name: "skill-manager", description: "Manage skills" },
	];
	const baseProvider = new CombinedAutocompleteProvider(
		[...builtinCommands, ...skillCommands],
		options?.basePath ?? process.cwd(),
	);
	editor.setAutocompleteProvider(createSkillAutocompleteProvider(baseProvider, skillCommands));
	const submissions: string[] = [];
	editor.onSubmit = (text) => {
		submissions.push(text);
	};
	return { editor, submissions };
}

function typeChars(editor: CustomEditor, text: string): void {
	for (const char of text) {
		editor.handleInput(char);
	}
}

describe("CustomEditor inline /skill autocomplete", () => {
	const skillCommands: SlashCommand[] = [
		{ name: "skill:pdf", description: "[user] Extract and transform PDF files" },
		{ name: "skill:officecli", description: "[user] Build Office documents" },
	];

	it("opens skill-only autocomplete anywhere at token boundaries and inserts with Enter like Tab", async () => {
		const { editor, submissions } = createEditorWithSkills(skillCommands);

		// At start of message: Enter inserts /skill:pdf with trailing space and does NOT submit
		typeChars(editor, "/skill");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		const renderedAtStart = editor.render(80).join("\n");
		expect(renderedAtStart).toContain("pdf");
		expect(renderedAtStart).toContain("officecli");
		expect(renderedAtStart).not.toContain("model");
		expect(renderedAtStart).not.toContain("skill-manager");

		editor.handleInput("\r");
		expect(submissions).toEqual([]);
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("/skill:pdf ");

		// Mid-line after Chinese text + space, filtered with :off, accepted with Enter
		typeChars(editor, "先提取内容，再用 /skill:off");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\r");

		expect(submissions).toEqual([]);
		expect(editor.getText()).toBe("/skill:pdf 先提取内容，再用 /skill:officecli ");

		// On a second line after CJK punctuation, filtered with space ("/skill pd"), accepted with Tab
		editor.handleInput("\n");
		typeChars(editor, "补充说明：/skill");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		typeChars(editor, " pd");
		await vi.waitFor(() => {
			const dropdownLines = editor.render(80).slice(4).join("\n");
			expect(dropdownLines).toContain("pdf");
			expect(dropdownLines).not.toContain("officecli");
		});
		editor.handleInput("\t");

		expect(editor.getText()).toBe("/skill:pdf 先提取内容，再用 /skill:officecli \n补充说明：/skill:pdf ");

		// Subsequent Enter with autocomplete closed submits the whole message
		editor.handleInput("\r");
		expect(submissions).toEqual(["/skill:pdf 先提取内容，再用 /skill:officecli \n补充说明：/skill:pdf"]);
	});

	it("does not trigger inside paths, closing XML tags, code, pastes, or after Escape dismissal", async () => {
		const { editor } = createEditorWithSkills(skillCommands);
		const expectClosed = async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(editor.isShowingAutocomplete()).toBe(false);
		};

		typeChars(editor, "check src/skill");
		await expectClosed();

		editor.setText("");
		typeChars(editor, "tag </skill");
		await expectClosed();

		editor.setText("");
		typeChars(editor, "看 `/skill");
		await expectClosed();

		editor.setText("");
		typeChars(editor, "看 `` x /skill");
		await expectClosed();

		editor.setText("```");
		editor.handleInput("\n");
		typeChars(editor, "/skill");
		await expectClosed();

		editor.setText("");
		editor.handleInput("\x1b[200~hello /skill\x1b[201~");
		await expectClosed();

		// Dismissing /skill with Escape does not re-trigger when continuing prose after a space
		editor.setText("");
		typeChars(editor, "讨论 /skill");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);

		typeChars(editor, " 触发器");
		await expectClosed();

		// Dismissing /skill:query with Escape does not re-trigger while typing in the same token
		editor.setText("");
		typeChars(editor, "讨论 /skill:p");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);

		typeChars(editor, "d");
		await expectClosed();

		// Dismissing /skill or /skill:query on line 0 stays closed while typing, but explicit Tab re-opens it
		editor.setText("");
		typeChars(editor, "/skill");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		typeChars(editor, " p");
		await expectClosed();

		editor.setText("");
		typeChars(editor, "/skill:p");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		typeChars(editor, "d");
		await expectClosed();
		editor.handleInput("\t");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		// A new token after the dismissed one opens the menu again
		editor.handleInput("\x1b");
		typeChars(editor, " 再看 /skill");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
	});

	it("re-opens on Backspace when narrowing past zero matches, preserves Enter submit for regular slash commands, and does not add a newline when Enter is bound to newLine", async () => {
		const { editor, submissions } = createEditorWithSkills(skillCommands);

		typeChars(editor, "use /skill:zzz");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(false));

		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		// Regular slash commands on line 0 still submit immediately on Enter
		editor.setText("");
		typeChars(editor, "/model");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\r");
		expect(submissions).toEqual(["/model"]);

		// When Enter is bound to newLine and Shift+Enter to submit, Enter on line-0 /skill inserts without adding a newline
		const swappedKeybindings = new KeybindingsManager({
			"tui.input.newLine": "enter",
			"tui.input.submit": "shift+enter",
		});
		const swapped = createEditorWithSkills(skillCommands, { keybindings: swappedKeybindings });
		typeChars(swapped.editor, "/skill");
		await vi.waitFor(() => expect(swapped.editor.isShowingAutocomplete()).toBe(true));
		swapped.editor.handleInput("\r");
		expect(swapped.submissions).toEqual([]);
		expect(swapped.editor.getText()).toBe("/skill:pdf ");
	});

	it("keeps inline /skill trigger and Enter-to-insert working when an extension wraps the autocomplete provider", async () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), getEditorTheme(), keybindings);
		const submissions: string[] = [];
		editor.onSubmit = (text) => submissions.push(text);
		const baseProvider = new CombinedAutocompleteProvider(skillCommands, process.cwd());
		const fakeInteractiveMode = {
			createBaseAutocompleteProvider: () => baseProvider,
			skillAutocompleteCommands: skillCommands,
			autocompleteProviderWrappers: [
				(current: typeof baseProvider) => ({
					triggerCharacters: ["#"],
					getSuggestions: (
						lines: string[],
						line: number,
						col: number,
						opts: { signal: AbortSignal; force?: boolean },
					) => current.getSuggestions(lines, line, col, opts),
					applyCompletion: (
						lines: string[],
						line: number,
						col: number,
						item: { value: string; label: string; description?: string },
						prefix: string,
					) => current.applyCompletion(lines, line, col, item, prefix),
				}),
			],
			settingsManager: { getEnableSkillCommands: () => true },
			autocompleteProvider: undefined as unknown,
			defaultEditor: editor,
			editor,
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeInteractiveMode);
		expect((fakeInteractiveMode.autocompleteProvider as { triggerCharacters?: string[] }).triggerCharacters).toEqual([
			"#",
		]);

		typeChars(editor, "用 /skill");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\r");
		expect(submissions).toEqual([]);
		expect(editor.getText()).toBe("用 /skill:pdf ");
	});
});

describe("AgentSession multi-skill and inline skill expansion", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	const skillBodies: Record<string, string> = {
		pdf: "Read PDF tables carefully.",
		officecli: "Write clean DOCX output.",
	};

	function createTempSkills(extraNames: string[] = []): Skill[] {
		const tempDir = join(tmpdir(), `pi-multi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		return ["pdf", "officecli", ...extraNames].map((name) => {
			const baseDir = join(tempDir, name);
			const filePath = join(baseDir, "SKILL.md");
			mkdirSync(baseDir, { recursive: true });
			writeFileSync(filePath, `---\ndescription: ${name} skill\n---\n${skillBodies[name] ?? `Use ${name}.`}\n`);
			return {
				name,
				description: `${name} skill`,
				filePath,
				disableModelInvocation: false,
				baseDir,
				sourceInfo: createSyntheticSourceInfo(filePath, {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir,
				}),
			};
		});
	}

	/** Sends each input through `session.prompt()` and returns the user message text the model received. */
	async function promptAndCapture(
		skills: Skill[],
		inputs: string[],
		prompts: PromptTemplate[] = [],
	): Promise<string[]> {
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({ skills, diagnostics: [] }),
			getPrompts: () => ({ prompts, diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		const received: string[] = [];
		harness.setResponses(
			inputs.map(
				(): FauxResponseFactory => (context) => {
					const user = context.messages.filter((message) => message.role === "user").at(-1);
					received.push(user ? getMessageText(user) : "");
					return fauxAssistantMessage("done");
				},
			),
		);
		for (const input of inputs) {
			await harness.session.prompt(input);
		}
		return received;
	}

	it("expands multiple inline /skill:name references in order and deduplicates repeated skills", async () => {
		const userInput = "请先用 /skill:pdf 提取表格，再用 /skill:officecli 生成文档，最后用 /skill:pdf 校验页码";
		const [expandedPrompt] = await promptAndCapture(createTempSkills(), [userInput]);

		const parsed = parseSkillBlocks(expandedPrompt!);
		expect(parsed).not.toBeNull();
		expect(parsed!.blocks.map((block) => block.name)).toEqual(["pdf", "officecli"]);
		expect(parsed!.blocks[0]!.content).toContain("Read PDF tables carefully.");
		expect(parsed!.blocks[1]!.content).toContain("Write clean DOCX output.");
		expect(parsed!.userMessage).toBe(userInput);
	});

	it("strips contiguous leading /skill:name prefixes while keeping trailing arguments and leading-punctuation prose", async () => {
		const [withArgs, withoutArgs, followedByPunctuation] = await promptAndCapture(createTempSkills(), [
			"/skill:pdf /skill:officecli convert report.pdf",
			"/skill:pdf /skill:officecli",
			"/skill:pdf，帮我提取表格",
		]);

		const firstParsed = parseSkillBlocks(withArgs!);
		expect(firstParsed?.blocks.map((block) => block.name)).toEqual(["pdf", "officecli"]);
		expect(firstParsed?.userMessage).toBe("convert report.pdf");

		const secondParsed = parseSkillBlocks(withoutArgs!);
		expect(secondParsed?.blocks.map((block) => block.name)).toEqual(["pdf", "officecli"]);
		expect(secondParsed?.userMessage).toBeUndefined();

		const punctuationParsed = parseSkillBlocks(followedByPunctuation!);
		expect(punctuationParsed?.blocks.map((block) => block.name)).toEqual(["pdf"]);
		expect(punctuationParsed?.userMessage).toBe("/skill:pdf，帮我提取表格");
	});

	it("matches loaded skill names, so sentence punctuation and non-spec names still expand", async () => {
		const [sentence, nonSpecName] = await promptAndCapture(createTempSkills(["中文技能"]), [
			"Please use /skill:pdf.",
			"/skill:中文技能 整理表格",
		]);

		const sentenceParsed = parseSkillBlocks(sentence!);
		expect(sentenceParsed?.blocks.map((block) => block.name)).toEqual(["pdf"]);
		expect(sentenceParsed?.userMessage).toBe("Please use /skill:pdf.");

		const nonSpecParsed = parseSkillBlocks(nonSpecName!);
		expect(nonSpecParsed?.blocks.map((block) => block.name)).toEqual(["中文技能"]);
		expect(nonSpecParsed?.userMessage).toBe("整理表格");
	});

	it("keeps references inside inline code and fenced code blocks literal", async () => {
		const mixed = [
			"Why does `/skill:pdf` fail, and what about `` run /skill:pdf ``?",
			"```text",
			"/skill:pdf extract",
			"```",
			"Answer with /skill:officecli.",
		].join("\n");
		const codeOnly = "Run `/skill:pdf` manually";
		const crlfFenced = "```text\r\n/skill:pdf\r\n```\r\n/skill:officecli";
		const [mixedPrompt, codeOnlyPrompt, crlfPrompt] = await promptAndCapture(createTempSkills(), [
			mixed,
			codeOnly,
			crlfFenced,
		]);

		const parsed = parseSkillBlocks(mixedPrompt!);
		expect(parsed?.blocks.map((block) => block.name)).toEqual(["officecli"]);
		expect(parsed?.userMessage).toBe(mixed);
		expect(codeOnlyPrompt).toBe(codeOnly);

		const crlfParsed = parseSkillBlocks(crlfPrompt!);
		expect(crlfParsed?.blocks.map((block) => block.name)).toEqual(["officecli"]);
		expect(crlfParsed?.userMessage).toBe(crlfFenced);
	});

	it("expands inline /skill:name references inside prompt templates", async () => {
		const template: PromptTemplate = {
			name: "convert",
			description: "Convert template",
			content: "Convert $1 using /skill:pdf and $2",
			filePath: "/virtual/convert.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/convert.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const [expandedPrompt] = await promptAndCapture(
			createTempSkills(),
			["/convert input.pdf /skill:officecli"],
			[template],
		);

		const parsed = parseSkillBlocks(expandedPrompt!);
		expect(parsed?.blocks.map((block) => block.name)).toEqual(["pdf", "officecli"]);
		expect(parsed?.userMessage).toBe("Convert input.pdf using /skill:pdf and /skill:officecli");
	});
});

describe("Multi-skill message rendering in InteractiveMode and HTML export", () => {
	it("renders each skill block as a separate collapsible component before the user message", () => {
		const chatContainer = new Container();
		const fakeInteractiveMode = {
			chatContainer,
			outputPad: 1,
			toolOutputExpanded: false,
			editor: { addToHistory: vi.fn() },
			getUserMessageText: (msg: { content: string }) => msg.content,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getMarkdownTransformers: () => [],
		};

		const multiSkillText = [
			'<skill name="pdf" location="/skills/pdf/SKILL.md">\nPDF instructions\n</skill>',
			'<skill name="officecli" location="/skills/officecli/SKILL.md">\nOffice instructions\n</skill>',
			"Combine /skill:pdf and /skill:officecli",
		].join("\n\n");

		(InteractiveMode as any).prototype.addMessageToChat.call(fakeInteractiveMode, {
			role: "user",
			content: multiSkillText,
			timestamp: Date.now(),
		});

		const skillComponents = chatContainer.children.filter(
			(child) => child instanceof SkillInvocationMessageComponent,
		);
		const userComponents = chatContainer.children.filter((child) => child instanceof UserMessageComponent);

		expect(skillComponents).toHaveLength(2);
		expect(skillComponents[0]!.render(80).join("\n")).toContain("pdf");
		expect(skillComponents[1]!.render(80).join("\n")).toContain("officecli");
		expect(userComponents).toHaveLength(1);
		const renderedUser = userComponents[0]!.render(80).join("\n");
		expect(renderedUser).toContain("Combine /skill:pdf and /skill:officecli");
		expect(renderedUser).not.toContain("<skill");
	});

	it("renders multiple skill blocks and comma-joined tree labels in HTML export template", () => {
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		const sliceBlock = (startMarker: string, endMarker: string): string => {
			const start = templateJs.indexOf(startMarker);
			const end = templateJs.indexOf(endMarker);
			expect(start).toBeGreaterThanOrEqual(0);
			expect(end).toBeGreaterThan(start);
			return templateJs.slice(start, end);
		};

		const script = [
			sliceBlock("function extractContent(content)", "function systemContentText(content)"),
			sliceBlock("function parseSkillBlock(text)", "function getSearchableText(entry, label)"),
			sliceBlock("function escapeHtml(text)", "// TREE RENDERING"),
			sliceBlock("function formatTimestamp(ts)", "function replaceTabs(text)"),
			sliceBlock("function renderCopyLinkButton(entryId)", "function computeStats(entryList)"),
			"helpers = { getTreeNodeDisplayHtml, renderEntry };",
		].join("\n");

		const context: {
			safeMarkedParse: (md: string) => string;
			helpers?: {
				getTreeNodeDisplayHtml: (entry: unknown, label?: string) => string;
				renderEntry: (entry: unknown) => string;
			};
		} = {
			safeMarkedParse: (md) => `<p>${md}</p>`,
		};
		runInNewContext(script, context);

		const entry = {
			id: "msg-1",
			type: "message",
			timestamp: "2026-11-22T08:00:00.000Z",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: [
							'<skill name="pdf" location="/skills/pdf/SKILL.md">\nPDF body\n</skill>',
							'<skill name="officecli" location="/skills/officecli/SKILL.md">\nOffice body\n</skill>',
							"Run both skills",
						].join("\n\n"),
					},
				],
			},
		};

		const treeHtml = context.helpers!.getTreeNodeDisplayHtml(entry);
		expect(treeHtml).toContain('<span class="tree-role-skill">skill:</span> pdf, officecli');
		expect(treeHtml).toContain("Run both skills");
		expect(treeHtml).not.toContain("<skill name=");

		const entryHtml = context.helpers!.renderEntry(entry);
		expect(entryHtml).toContain("[skill] pdf");
		expect(entryHtml).toContain("[skill] officecli");
		expect(entryHtml).toContain("<p>PDF body</p>");
		expect(entryHtml).toContain("<p>Office body</p>");
		expect(entryHtml).toContain(
			'<div class="user-message"><div class="markdown-content"><p>Run both skills</p></div></div>',
		);
		expect(entryHtml).not.toContain('<skill name="officecli"');
	});
});
