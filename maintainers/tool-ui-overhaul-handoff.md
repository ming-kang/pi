# 工具调用 UI 全面修复 — 交接文档

> 状态:进行中,WP1、WP2 已完成并通过测试;WP3–WP8 未开始。
> 本文档不随发布提交,仅供接力会话使用。工作区当前有未提交的改动(见"已完成"一节),owner 未要求 commit——遵守 AGENTS.md:不要主动提交。

## 一、动机与背景

Owner 在 0.82.6 发布后截图指出 `todo create_many` 的工具行不美观(`todo create_many 3 tasks` / `Created 3 tasks: #1, #2, #3`——三层都看不到任务内容),要求**先做一次全部工具调用 UI 的只读评审**(折叠态+展开态),之后**全面修复**。

评审通过五个并行调查 agent 完成,覆盖了全部 12 个模型可见工具:

- 内置 7 个:`read` `bash` `edit` `write` `find` `grep` `ls`(src/core/tools/)
- 扩展 5 个:`todo` `subagent` `question` `exit_plan` `deepwiki`(src/extensions/)
- llama/router/rewind/statusline 只注册 provider/命令/钩子,没有工具行 UI。

### 壳层机制(评审确认的基线)

- `src/modes/interactive/components/tool-execution.ts`:每个调用 = `●`(pending/running=warning 黄、成功=绿、失败=红)+ renderCall 行;结果 = `│ `(dim)前缀 + renderResult。`ToolChromeComponent` 原本只给第 0 行加前缀,续行裸缩进 2 空格。
- `tool-group.ts`:同 `toolGroup` 的连续调用折叠成组,折叠时只渲染各调用的 headline(`renderCallSummary`),最后一行追加 `(ctrl+o to expand)`。评审时只有 `read`/`find`(explore 组)与 `todo` 入组。
- 无自定义渲染器的工具走 fallback:`name(key=value…)` + 尾 10 行预览。
- ctrl+o 是全局展开开关(`app.tools.expand`,keybindings.ts:87)。

### 评审结论(修复的依据)

**P0 实际 bug**(4 个):
1. `theme.fg` 不可嵌套(theme.ts:359-363,`${ansi}${text}\x1b[39m`),内层 reset 吃掉外层色 → subagent 折叠尾行 `(ctrl+o to expand)` 右括号变默认色(subagent/render.ts:553)。
2. 手动 `!!` 命令的 dim 边框色在首次输出后丢失(bash-execution.ts:138 重建 header 时硬编码 `"bashMode"`)。
3. todo `create_many` 单条时显示 `1 tasks`(todo/view.ts:178 无单复数)。
4. subagent `formatDuration` 阈值 90s,60–89 秒显示 `75s` 而非 `1m 15s`(subagent/render.ts:345)。

**P1 信息缺失**:
- todo `create_many`:headline/组摘要/模型文本三层无任务主题;展开只显示前 3 个 subject(view.ts:153-162 `slice(0,3)`);成功摘要连 create 单条的 subject 都丢(view.ts:366-403);delete 摘要丢 subject。
- subagent 批次 run 行失败原因 64 字符硬切词中央(render.ts:12 `RUN_LINE_EXCERPT_LIMIT=64`、:37-39 truncate),而运行中 detail 完全不截断(:245),句边界逻辑 `leadingSentences`(:121-131)只用于折叠单委派。
- question:renderCall 不接 expanded(index.ts registerTool 的 renderCall 是二参函数),问题正文在 transcript 里**永不可见**;`Cancelled` 一个词丢掉已作答部分(render.ts:41-66,而 details.answers 里有——results.ts:63-84 已确认 cancelled/clarification 都带 answers,**纯渲染层可修**);错误行暴露机器码(`Question error: preview_multiselect`)。
- edit:diff 挂在 call 区且完全不受 ctrl+o 控制,大 diff 无限刷屏。

**P2 一致性**(修一处全场受益):
- 折叠预览行数:bash 5 / read 仅错误 10 / grep 15 / find·ls 20 / fallback 10。
- 截断提示三套措辞两个位置;省略号 `...`/`…`/` …` 三种并存。
- `limit` 格式:find/ls `(limit N)` vs grep `limit N`(无括号)。
- 路径:read/ls/edit/write 用 `renderToolPath`(accent+OSC8 超链接),find/grep 只 `shortenPath` 灰色。
- grep/ls 没进 explore 组。
- read 行范围用 warning 纯黄表达正常参数(read.ts:71)。
- bash 折叠 headline 无条件加 ` …`(两行短命令看似被截断)。
- write 提示独有 `M total` 字段。
- 键名 hint 两套语法;`tui.select.cancel` 渲染成 `escape/ctrl+c` 小写全列(dialog.ts:59-60 直接 `getKeys().join("/")`)。
- pending/running 均为黄点,除 bash 外无运行反馈。
- subagent 一批(详见 WP4)。
- plan 正文逐行 dim 纯文本非 Markdown;两对话框边框色/hint 语法/Context 百分比格式互不一致。
- deepwiki(最完善,评审建议以其"结果感知一行摘要"为模板):headline question 不压缩空白、折叠摘要整条 accent 太亮、`(ctrl+o to expand)` 独占一行。

## 二、Owner 已拍板的决策

1. **模型侧文案一并修**:todo create_many 的模型结果文本(state.ts:1285-1286 `Created 3 tasks: #1, #2, #3`)加 subject,与单条 create(`Created #4: Fix login redirect (pending)`)对齐。除此之外仍遵守 AGENTS.md:不改 schema/协议/结果结构,其余修复只动 UI 渲染层。
2. **`│` rail 延续到结果块每行**(含空行渲染为裸 `│`),call 侧续行维持 2 空格缩进。已实现。
3. **Running 计时行壳层通用化**:执行超 2s 且未 settled 时壳层显示 `Running… (Ns)`;`ToolDefinition` 新增 `rendersOwnProgress?: boolean` 供自带进度 UI 的工具 opt-out(subagent/question/exit_plan 已标 true;bash 的自有实现已删除,deepwiki/todo/内置工具走壳层)。已实现。

## 三、工作包计划与状态

| WP | 内容 | 状态 |
|---|---|---|
| WP1 | 壳层:theme 嵌套、│ rail、通用 Running 行、截断 helper | ✅ 完成 |
| WP2 | 内置七工具 + bash-execution `!!` bug | ✅ 完成 |
| WP3 | todo:create_many 内容化、摘要保 subject、展开逐任务、模型文案 | ⬜ 未开始 |
| WP4 | subagent:截断策略、展开态一致性、杂项 | ⬜ 未开始 |
| WP5 | question:调用行可展开、取消态、错误行、对话框 | ⬜ 未开始 |
| WP6 | plan 正文 Markdown 化 + deepwiki 小修 | ⬜ 未开始 |
| WP7 | 键名 hint 统一 | ⬜ 未开始 |
| WP8 | 全量测试、docs、CHANGELOG、delta 登记 | ⬜ 未开始 |

## 四、已完成明细(WP1 + WP2)

### WP1 壳层(全部通过类型/lint/测试)

- **theme.ts:359-370**:`fg`/`bg` 改为嵌套安全——`${ansi}${text.replaceAll("\x1b[39m", ansi)}\x1b[39m`(bg 同理 `[49m`)。内层 reset 后恢复外层色。这一处修复顺带解决了 subagent :553 的括号变色,WP4 无需再动那里。
- **tool-execution.ts**:
  - `ToolChromeComponent` 构造第三参改 options 对象:`{ trimLeadingBlankLines, continuationPrefix, blankLinePrefix }`。`wrapResult` 传 `continuationPrefix: theme.fg("dim","│ ")`、`blankLinePrefix: theme.fg("dim","│")` → rail 延续;`wrapCall` 走默认(续行 2 空格)。
  - 通用 Running 行:字段 `progressStartedAt`/`progressTimer`;`markExecutionStarted()` 里在 `!getRendersOwnProgress() && getRenderShell()!=="self"` 时记时并起 1s interval(回调里 `!isPartial` 自清);`updateResult(final)` 清 timer;`updateDisplay()` 末尾在 `executionStarted && isPartial && elapsed>=2000` 时 `addResult(Running… (formatElapsed))`。`formatElapsed`:<60s 一位小数,≥60s `Xm Ys`。
  - fallback 结果提示改用共享 helper 且**移到预览上方**(取尾语义)。
- **render-utils.ts**:新增 `collapsedLinesHint(theme, hidden, "earlier"|"more", {total?})` → `… (N earlier/more line(s)[, M total], ctrl+o to expand)`。统一省略号 `…`、单复数。core→interactive 的 keyHint import 已有先例(bash.ts 原本就 import),不算新依赖方向。
- **types.ts**:`ToolDefinition.rendersOwnProgress?: boolean`(:492 附近,renderShell 后)。
- **subagent/index.ts、question/index.ts、plan/index.ts**:registerTool 处标 `rendersOwnProgress: true`。
- **bash.ts**:删除自有 Running 实现(`BashRenderState`、`formatDuration`、renderCall 的 startedAt、renderResult 的 interval、rebuild 尾部的 Running 段、`BASH_PROGRESS_THRESHOLD_MS`),定义泛型第三参移除;结果提示接 helper。

### WP2 内置工具

- **bash.ts**:折叠 headline 的无条件 ` …` 改为诚实后缀——多行命令 `(+N lines)`(muted),单行超宽保留 ` …`;`truncateToWidth` 省略号统一 `…`。(`fitCollapsedBashCall` 加 suffix 参数,`formatTruncatedBashCall` 数物理行。)
- **read.ts**:行范围 `:12-40` warning→muted;错误场景截断提示接 helper;清理不再用的 keyHint import(keyText 仍在用)。
- **edit.ts**:新增 `EDIT_COLLAPSED_DIFF_LINES=10`、`diffStat`/`formatDiffStat`(headline 追加 ` +N -M`,toolDiffAdded/Removed 色)、`boundDiffBody`(折叠截前 10 行 + hint);`buildEditCallComponent` 加 `expanded` 参数(renderCall 传 `context.expanded`,renderResult 的重建点传同值);`formatEditResult` 加 `expanded`,罕见的 resultDiff 分支同样受控。
- **write.ts**:提示接 helper(保留 total 字段——`… (142 more lines, 152 total, ctrl+o to expand)`)。
- **find.ts**:路径改 `renderToolPath`(` in ` 保持 toolOutput,路径 accent+超链接,空回退 `.`);提示接 helper;formatFindCall 加 cwd 参数(renderCall 闭包传 cwd)。
- **grep.ts**:同 find 的路径处理;`limit N` → `(limit N)`;新增 flags 段(`ignoreCase→-i`、`literal→-F`、`context→-C N`,toolOutput 色,glob 括号后);`toolGroup: "explore"`;提示接 helper。
- **ls.ts**:`toolGroup: "explore"`;提示接 helper。
- **bash-execution.ts**:`colorKey` 提为实例字段,`updateDisplay` 重建 header 用 `this.colorKey`,修复 `!!` dim 色丢失。

### 测试状态

- 已更新断言:`test/tool-execution-component.test.ts:226-227`(rail 后空行是 `│`);`test/edit-tool-no-full-redraw.test.ts` 两个用例(组件 `setExpanded(true)` 保持大 diff 断言意图,另补折叠态断言:含前部行、不含 `line 950 changed`、含 `more lines`)。
- 已跑绿:tool-execution-component、bash-tool-rendering、bash-execution-width、edit-tool-no-full-redraw、edit-tool-legacy-input、theme-picker、theme-export、syntax-highlight、export-html-whitespace、export-html-skill-block、subagent-render、todo-render、plan-render。
- **Windows 本地既有失败(非本次改动,勿修)**:`test/tools.test.ts` 的 3 个——edit EACCES ×2(POSIX 权限语义)、grep "flag-like patterns"(rg 把 `C:\Users` 的 `\U` 当 hex escape)。全部在 execute 路径,本次 diff 未触及;AGENTS.md 明言 Windows 平台差异以 Ubuntu CI 为权威。
- biome、tsgo --noEmit 全部干净。注意:用脚本批量改文件时保持 CRLF(仓库工作区是 CRLF,写成 LF 会触发 biome;`npm run format` 可修)。

## 五、未完成工作包的实施方案

以下 file:line 以当前工作区为准(WP1/2 的改动可能使个别行号略移,先 grep 定位)。每个 WP 完成后:跑该扩展的 `test/<name>-*.test.ts` 迭代至绿,再 `tsgo --noEmit` + `npx biome check`。

### WP3 todo(owner 点名的原始问题,优先做)

文件:`src/extensions/todo/view.ts`(渲染)、`src/extensions/todo/state.ts`(模型文案)、`test/todo-render.test.ts`。

1. **headline**(view.ts:172-195):create_many 分支现在是 `todo create_many` + dim `N tasks`(:176-179)。目标:动作词化为 `todo create`,后接 `N tasks · <subject 预览>`:复用 `callBatchSubjects`(:153-162,`"; "` 连接前 3 个),建议改为逗号连接前 2 个 + `+N more`,单条时直接显示该 subject。修单复数(`1 task`)。
2. **组内成功摘要**(view.ts:366-403):
   - create(:374 附近):`todo created 1 task #4` → `todo created #4 <subject>`(subject 从 args 取,operation 里若有更好)。
   - create_many:`todo created 3 tasks #1, #2, #3` → `todo created #1–#3 · <前2个subject>, +N more`(连续 id 用区间,不连续保持逗号列)。
   - delete(:396):带 subject(details.items 快照里按 id 查——参照 get 的 :334-347 做法)。
3. **展开态**(view.ts:197-232):create_many 目前只有 `batch: 3 tasks (前3个)` 一行。目标:逐任务一行 `#k <subject>`(有 blockedBy/blockedByKeys 时追加 ` · blocked by …`),下挂各自 description(dim,可截 ~120);覆盖全部条目,删除 `slice(0,3)`。注意展开态 headline 与细节行都在 renderCall 里(todo 无 renderResult)。
4. **模型文案**(state.ts:1285-1286):`Created 3 tasks: #1, #2, #3` → 逐条 `#1 Wire parser` 式列表(与 :1279-1284 单条格式家族一致)。**这是 owner 明确批准的唯一模型侧改动**。
5. 可选(评审建议,owner 未单独拍板,做不做由接力判断):给 todo 补 renderResult,使**未成组**的单独调用不再把模型原文整段回显(现在 headline `todo update #1 in_progress` + 结果 `Updated #1 (pending → in_progress)` 几乎逐字重复)。若做,折叠态渲染与组摘要同款的一行(复用 :366-403 的逻辑),展开态保留模型原文。
6. 测试:test/todo-render.test.ts:114-165 是 headline 断言区,组摘要断言在后段;逐条更新并为新行为补断言(单复数、区间 id、展开逐任务)。

### WP4 subagent

文件:`src/extensions/subagent/render.ts`(唯一渲染源,580 行)、`test/subagent-render.test.ts`。

1. **失败原因独立行**(核心,截图问题):`runLine`(:241-260)现在把 failed/aborted 的 `run.error` 用 `excerpt(…, 64)` 拼在 ` — ` 后。目标:失败/中止的 run 行不再拼 error,改为紧随其后的独立行(缩进对齐,error 色,`excerpt(error, 200)` 或 `leadingSentences`),折叠批次与展开目录都生效。成功摘录保留在行内但升到 96 并走 `leadingSentences`(:121-131 现仅折叠单委派用)。
2. **运行中 detail 截断**(:245 与 :286):`runIntent` 返回值无上限,统一 `excerpt(…, 100)`(与 LIVE_TAIL_LIMIT 一致)。
3. **formatDuration**(:338-347):阈值 90 → 60(60s 起显示 `1m 0s`)。
4. **裸状态字符串**(:280 queued、:303 settled 无输出):改用 `statusWord`(:212-225)。
5. **`ctx:` 空格**(:235-239 runProgressText 与 :309-320 collapsedUsageText 等处):`ctx:24k` → `ctx: 24k`,与 `cwd: x` 一致。全文件 grep `ctx:` 统一。
6. **Activity 对齐**(:447-457):成功行补两格前缀空位,与 `× `/`› ` 行左缘对齐。
7. **Report 亮度**(:481-486):`new Markdown(run.finalOutput, 0, 0, getMarkdownTheme())` 传 defaultTextStyle 至 toolOutput 灰阶(查 Markdown 组件签名;question/dialog.ts:438 有用例)。
8. **序号风格统一**:目录行(:565,`✓ 1 · Explorer`)与 section 头(:422-431,`── 1 ✓ Explorer`)统一为 `1 · ` 一种(建议 section 头改 `── 1 · ✓ Explorer …`)。
9. 批次 run 行运行中补 `$`(与单委派 :289 对称)或统一去掉——二选一,建议补上。
10. 验证 :553 括号颜色已被 theme 修复(视觉验证即可,勿再包一层)。
11. 测试:subagent-render.test.ts:253(`0 tool uses` 恒显)、:514-531(truncation notice)等,逐条适配。

### WP5 question

文件:`src/extensions/question/{index.ts,render.ts,dialog.ts,types.ts}`、`test/question-*.test.ts`。

1. **renderCall 接 expanded**:index.ts registerTool 的 `renderCall: renderQuestionCall` 目前是 `(args, theme)` 二参(render.ts:33-39)。改三参签名接 `context`,`context.expanded` 时在 headline 下列出每个问题:`<header>: <question 全文>`(dim),多选注明;有 result 后展开态已有答案清单(render.ts:53-65),调用行的问题列表与之呼应。
2. **取消态**(render.ts:41-66):`Cancelled` → `Cancelled · answered N of M`(N=details.answers.length,M 从 args.questions 长度取);`needs_clarification` 同理。expanded 时列出已答条目(复用 answered 分支的渲染)。注意现在 cancelled 分支在 expanded 判断之前 return——调整分支顺序。details 无需改(answers 已在,results.ts:63-84)。
3. **错误行**:`Question error: preview_multiselect` → 显示人类可读 message。message 在 content 文本 `Question tool error (code): message`(results.ts:23-30)里,从 content 解析,或(更稳)在 errorResult 的 details 加 `message` 字段——details 加可选字段属 UI 侧数据,可接受,但注意旧会话回放兜底。
4. **对话框**(dialog.ts):hint 行(:596-647)补数字快选提示(如单选 `1-9 select`);`Type something.`(types.ts:71 OTHER_OPTION)去句号并同步 schema.ts:8 保留词与相关断言;单/多选左缘统一(:517-545,单选 marker 列补空位使编号对齐)。键名渲染交给 WP7。
5. 测试:question-dialog、question-render(若有)逐条适配;取消态补新断言。

### WP6 plan + deepwiki

plan(`src/extensions/plan/view.ts`、`test/plan-render.test.ts`):
1. 展开正文(view.ts:53-62):逐行 dim 纯文本 → `Markdown` 渲染(import getMarkdownTheme,参照 subagent Report;考虑 revises 行保持 dim)。无需加截断(计划是要读的),但若 Markdown 组件需要宽度处理注意 Text→Component 的返回类型变化(renderCall 返回 Component,现在是拼 string 进 Text——需要改成 Container)。
2. 结果行(view.ts:86-94):决策行(`Compacting context, then executing`)是主信息,升为正常色;`Saved to <path>` 降 dim(路径仍 `shortenPlanPath`)。
3. Context 行(view.ts:30-34):`Context now 29% full` → 与 statusline 一致的 `Context 29.4% of 200k`(statusline/index.ts:207 格式为 `CTX 42.3%/200k`,对话框里可稍展开;拿得到窗口大小就带上,拿不到就 `Context 29.4%`)。
4. cancelled 的 `No approval was pending` 用 warning 而非 dim(view.ts:67-72 DECISION_SUMMARY 与 :86-94 的着色处)。

deepwiki(`src/extensions/deepwiki/render.ts`):
1. :136 headline question:先 `\s+→" "` 压缩再 `truncateText(…, 64)`。
2. :169-171 折叠摘要 accent → toolOutput;`(ctrl+o to expand)` 从独立行并入摘要行尾 ` (ctrl+o to expand)`(dim,参照 tool-group 行尾风格),或直接复用统一 hint 措辞。
3. 检查有无 deepwiki 渲染测试(评审未见,可能无;有则适配)。

### WP7 键名 hint 统一

文件:`src/modes/interactive/components/keybinding-hints.ts`、`extension-selector.ts:75-84`、`question/dialog.ts:59-60`。

- 现状:`keyText` 渲染原始键 id 小写全列;dialog.ts:59-60 直接 `getKeys().join("/")` → `escape/ctrl+c`、`left/ctrl+b/right/ctrl+f`。
- 目标:hint 只取**首键**并美化大小写(`escape`→`Esc`、`left`→`←` 或 `Left`);多键绑定不再全列。在 keybinding-hints.ts 加导出(如 `keyLabel(action)`),extension-selector 与 question dialog 接入。两对话框 hint 语法(`key desc` 双空格 vs `key to verb` ` • `)统一成一种(建议 ` • ` + `key verb`)。
- 注意:keybinding-hints.ts 会成为新 hybrid 文件(见 WP8);extension-selector.ts 已在 hybrid 登记。改动会波及 plan 审批框、question 对话框、trust/config 等所有 extension-selector 用户,测试 test/extension-selector.test.ts。

### WP8 收尾(必须完整执行)

1. **测试全量**:Windows 本地用 `npm run test:isolated`(勿直接 vitest 全量);已知平台噪音见上。改动过的测试逐个跑绿。
2. **docs**(distribution-owned,要与新行为一致):`docs/bundled/tool-presentation.md`(rail、Running 行、统一提示、explore 组新成员)、`docs/bundled/extensions/todo.md`(create_many 新展示)、`subagent.md`(失败行、摘录规则)、`plan.md`(Markdown 正文、对话框文案)、`question.md`(展开、取消态)。`npm run check:docs` 验证链接。
3. **CHANGELOG.md**:在 `[Unreleased]` 下按 Added/Changed/Fixed 记录(参照 0.82.5/0.82.6 条目的密度与风格;theme 嵌套、`!!` 色、复数、时长格式放 Fixed;rail/Running 行/todo/subagent/question/plan 重设计放 Changed)。
4. **delta 登记**:`maintainers/upstream.json` hybrid 数组新增:`src/core/tools/write.ts`、`src/core/tools/grep.ts`、`src/core/tools/ls.ts`、`src/core/tools/render-utils.ts`、`src/modes/interactive/components/bash-execution.ts`、`src/modes/interactive/components/keybinding-hints.ts`(若 WP7 动了)以及新改的 test 文件(以 `npm run diff:upstream -- --check` 的输出为准补齐);`maintainers/delta.md` 第 5 节(Native tool presentation)扩写本次变化(rail、通用 Running 行、collapsedLinesHint、explore 组扩容、edit 折叠 diff),第 6 节(themes)补 fg/bg 嵌套安全,第 7 节视扩展改动微调。最后 `npm run diff:upstream -- --check` 必须过。
5. `npm run check`(全链)+ `npm run build`。
6. **真 TTY 手动验证**(AGENTS.md 要求):pending/success/error/折叠/展开各态,重点看:`│` rail 在 subagent 展开长卡、慢命令的 `Running… (Ns)`、edit 大 diff 折叠、grep/ls 进 explore 组、`!!` 命令 dim 色保持、todo 批量创建各态、`/reload` `/tree` 生命周期。

## 六、思路与原则(给接力者)

- **一切修复只动渲染层**,唯一例外是 todo create_many 的模型文案(owner 批准)。不改 schema、不改 execute、不改 wire 协议。
- **统一优先于局部美化**:能收敛到共享 helper(collapsedLinesHint)或基础设施(theme 嵌套、rail、壳层 Running)的,不要在各工具里各修各的。
- **截断要诚实**:`…` 只表示"真的被截了";隐藏行数尽量报数字(`(+N lines)`、`N more lines`);错误信息的关键常在句尾,宁可独立成行也不硬切。
- **deepwiki 是摘要模板**:"结果感知的一行折叠摘要"是理想形态,todo/question 的摘要向它靠。
- **颜色语义**:warning 只给告警(read 行范围之教训);标题/内容的明暗层级在相邻 section 间保持同向(subagent Activity 之教训)。
- 每个 WP 保持可独立验收:改完即跑该域测试,不留跨 WP 的悬空断言。
- AGENTS.md 红线:top-level import、`.ts` 后缀、erasable syntax、不 `git add -A`、不主动 commit、KEYBINDINGS 不硬编码。
