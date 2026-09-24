**上游差异预算规范，2026-09-22**

状态：已于 2026-09-24 按 v0.87.1 基线实施，现为历史记录。本页是差异治理的总体设计：成本模型、度量、账本、工具，以及六个工作项。边界规则见 [AGENTS.md](../../AGENTS.md)，职责见 [Architecture](../architecture.md)，同步流程见 [Upstream synchronization](../upstream.md)。

第 2 至 4 节的规则已移交 [Upstream synchronization](../upstream.md)，以那里为准；本页不作为第二处规则来源。实施结果与偏离设计之处见第 7 节。

## 1. 依据

### 1.1 前提与成本模型

上游通常不接受新贡献者 PR，因此**每条 delta 都按永久对待**。现行 `deltas.json` 的 `bugfix` 与 `windows-compat` 类别隐含"上游修好即可退休"，但没有可观测的退休信号时，它们同样是永久的。

目标因此不是减少 delta 数量，而是降低每次同步的成本：

```
同步成本 ≈ 冲突面 × 上游触碰频率 × 失败被发现的难度
```

本设计用三件事分别对付三个因子：

| 因子 | 手段 |
| --- | --- |
| 冲突面 | 重构，把逻辑从上游文件移到本仓自有文件（第 5 节） |
| 触碰频率 | 不可控，但可测，用来排优先级（第 2 节） |
| 发现难度 | 账本登记符号锚点与测试，上游改名时立即报错（第 3 节） |

### 1.2 数据

以 v0.87.0 基线（源树 `e0fcee077666`）为准，只读测得。形态判据见第 2.2 节。

| 形态 | 文件数 | 冲突面 | 占比 |
| --- | --- | --- | --- |
| `rewrite` | 16 | 3403 行 | 85% |
| `patch` | 33 | 612 行 | 15% |
| `own` | 237 | 0 行 | — |

`own` 指上游不存在的文件，无论多大都不产生冲突面，`src/core/background/` 与九个捆绑扩展都在这一档。负担来自它们在上游文件里留下的挂载点。

频率窗口为基线前 120 天（2230 个上游提交），风险 = 冲突面 × 触碰次数：

| 文件 | 冲突面 | 重缩进 | hunk | 触碰 | 风险 |
| --- | --- | --- | --- | --- | --- |
| `src/core/agent-session.ts` | 1164 | 878 | 31 | 89 | 103596 |
| `src/modes/interactive/interactive-mode.ts` | 730 | 366 | 44 | 139 | 101470 |
| `src/core/tools/bash.ts` | 268 | 24 | 10 | 17 | 4556 |
| `src/core/extensions/types.ts` | 76 | 0 | 18 | 46 | 3496 |
| `src/core/agent-session-runtime.ts` | 320 | 276 | 6 | 7 | 2240 |
| `src/core/settings-manager.ts` | 59 | 0 | 8 | 34 | 2006 |
| `src/modes/interactive/components/tool-execution.ts` | 346 | 54 | 16 | 5 | 1730 |
| `src/core/sdk.ts` | 86 | 0 | 6 | 20 | 1720 |
| `src/core/model-config.ts` | 41 | 0 | — | 16 | 656 |
| `src/core/trust-manager.ts` | 62 | 0 | — | 6 | 372 |
| `src/core/keybindings.ts` | 52 | 0 | — | 7 | 364 |
| `src/core/resource-loader.ts` | 21 | 0 | — | 15 | 315 |
| `src/core/usage-totals.ts` | 103 | 0 | — | 3 | 309 |
| `src/utils/shell.ts` | 23 | 0 | — | 3 | 69 |
| `src/core/tools/render-utils.ts` | 19 | 0 | — | 1 | 19 |
| `src/modes/interactive/components/keybinding-hints.ts` | 66 | 0 | — | 0 | 0 |
| **合计** | | | | | **222918** |

### 1.3 结论

- **前两个文件占总风险的 92%。** 计划必须先处理它们。
- `agent-session.ts` 与 `agent-session-runtime.ts` 共 1484 行冲突面，其中 1154 行是 `try/finally` 包裹后台暂停造成的整体右移。这是最大且几乎无行为风险的一笔回收。
- `interactive-mode.ts` 被触碰最多、hunk 最分散。只按行数排序会把它排在后面。
- `keybinding-hints.ts` 零触碰。**形态难看不等于成本高**，排序看风险，不看形态。
- `bash.ts` 排第三，但除 24 行重缩进外都是后台交接对内联执行路径的真实替换，基本不可约，不列入计划。若上游日后抽出 shell 执行层，再重估。

## 2. 度量

### 2.1 指标

对基线 `B` 与路径 `p`：

| 指标 | 定义 |
| --- | --- |
| `surface` | `git diff --numstat B -- p` 两列之和 |
| `reindent` | `surface` 减去 `git diff -w --numstat B -- p` 两列之和 |
| `hunks` | `git diff B -- p` 中 `^@@` 行数 |
| `touches` | `git rev-list --count --since=<基线日期减窗口> <基线提交> -- <sourceSubtree>/p` |
| `risk` | `surface × touches` |

`sourceSubtree` 与基线提交取自 `upstream.json`。窗口默认 120 天，可用 `--window <天数>` 调整，数字必须连同窗口一起记录。窗口是回溯估计，每次同步重新测量。

### 2.2 形态

三档，按顺序判定：

```
own      ⟸ 上游无此文件（git cat-file -e B:p 失败）
rewrite  ⟸ del > 8 或 reindent > 10
patch    ⟸ 其余
```

两个阈值在脚本中具名导出。调整阈值须重算基线并在同步记录中声明。

形态由工具计算，**不写进账本**，账本只为 `rewrite` 记录理由（第 3 节）。

### 2.3 基线

第 1 节数字来自一次性脚本，仅供论证。WS-1 完成后，以工具输出重新生成，写入首份同步记录作为权威基线。工具不得硬编码本页数字。

## 3. 账本 v2

### 3.1 格式

新账本 `maintainers/concerns.json` 以关切为键，替代以路径为键的 `deltas.json`。现行格式的问题是：`agent-session.ts` 一条 `intent` 混了四件互不相干的事，而且符号被上游改名时不会报错。

```jsonc
{
  "version": 2,
  "concerns": [
    {
      "id": "background-execution",
      "why": "后台与前台 shell、Subagent 执行的监管、投递与有界保留。",
      "paths": [
        { "path": "src/core/agent-session.ts",
          "anchors": ["_withBackgroundPaused"],
          "rewrite": "会话生命周期暂停必须跨越上游方法体。" },
        { "path": "src/core/usage-totals.ts", "anchors": ["getAccountedUsages"] }
      ],
      "tests": ["test/agent-session-background.test.ts"],
      "watch": "…"
    }
  ]
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | kebab-case，唯一，稳定 |
| `why` | 是 | 一句话；长解释归 [Architecture](../architecture.md) |
| `paths[].path` | 是 | 与上游有差异的路径；目录以 `/` 结尾 |
| `paths[].anchors` | 否 | 本关切在该文件中引入或改动的符号名 |
| `paths[].rewrite` | 条件 | 该路径实测为 `rewrite` 时必填，说明为何不能更薄 |
| `tests` | 否 | 覆盖该关切的测试路径 |
| `watch` | 否 | 可观测的退休信号；缺省即永久 |

同一路径可以出现在多个关切中。

### 3.2 校验规则

| 编号 | 规则 |
| --- | --- |
| C1 | 每条差异路径至少被一个关切认领（现行规则） |
| C2 | `tests` 中的路径存在（现行规则） |
| C3 | `id` 唯一且为 kebab-case |
| C4 | 实测为 `rewrite` 的路径，至少一个认领它的关切写了 `rewrite`；实测不是 `rewrite` 却写了 `rewrite`，也失败 |
| C5 | 每个 `anchors` 条目出现在该路径 diff 的增删行中 |

全部为失败级，不设警告。C4 让 `rewrite` 从默认状态变成需要书面理由的决定，并在重构后自动提示删掉过期理由。C5 让上游改名在当次同步就暴露。

### 3.3 关切清单

现有 63 条路径记录归并为 18 个关切：

`distribution-identity`、`bundled-extensions`、`background-execution`、`context-snapshot`、`compaction-trigger-percent`、`tui-fullscreen-default`、`tool-presentation`、`tool-grouping`、`extension-editor-host`、`extension-model-runtime`、`provider-editor-support`、`keybindings`、`windows-path-identity`、`windows-shell-normalization`、`windows-find-glob`、`windows-external-editor`、`auth-min-expiry`、`docs-and-tests`。

Windows 修正拆成四个关切，因为退休条件不同：`windows-find-glob` 可以 `watch` fd 版本，其余三条没有信号。

## 4. 工具与流程

### 4.1 命令

| 命令 | 行为 |
| --- | --- |
| `npm run diff:upstream` | 完整报告，新增 `form`、`surface`、`reindent`、`hunks` 列 |
| `npm run diff:upstream -- --check [--staged]` | 执行 C1–C5；不访问网络，不计算 `touches` |
| `npm run diff:upstream -- --risk [--window <天数>]` | 按 `risk` 降序输出第 2.1 节全部指标及合计 |
| `npm run diff:upstream -- --target <tag>` | 现行行为不变 |

退出码：`0` 通过，`1` 校验失败，`2` 用法或环境错误。

提交钩子不得抓取或改动引用，所以 `touches` 与 `risk` 不进入 `--check`。缺少 `upstream` 远程历史时，`--risk` 输出 `n/a` 并以 `0` 退出。风险只用于排优先级，不做闸门。

### 4.2 同步记录

`maintainers/syncs/*.md` 顶部增加：

```yaml
---
upstreamTag: v0.87.1
window: 120
rewriteSurface: 3403
risk: 222918
---
```

预算规则：`rewriteSurface` 相对上一份记录上升时，正文须说明原因。`risk` 只记录，用于观察趋势。两者都要记录，因为只看行数会把零触碰的文件误当成重构目标。

## 5. 实施计划

按优先级分三档。每项独立可提交，提交钩子全程保持通过。

| 档 | 工作项 | 估时 | 理由 |
| --- | --- | --- | --- |
| 前置 | WS-1 账本与工具 | 1 天 | 没有它，后续收益无法验证，也无法防止退化 |
| 主体 | WS-2 后台暂停外提 | 1–2 天 | 回收 `agent-session.ts` 的重缩进 |
| 主体 | WS-3 `interactive-mode.ts` 抽装配器 | 2–3 天 | 风险第二、最分散 |
| 附带 | WS-4 `ui.editorHost` 收口 | 半天 | 删除 `rpc-mode.ts` 的 delta |
| 附带 | WS-5 路径身份与 `validateCompat` 外移 | 半天 | 两个小文件回到 `patch` |
| 附带 | WS-6 键位注册接口 | 半天 | 解除扩展对核心键位表的依赖 |

附带档合计不足总风险的 2%，保留它们是为了删除 delta、解除扩展对核心的耦合，而不是为了数字。

### WS-1 账本与工具

三步：

1. **度量。** 在 `scripts/diff-upstream.mjs` 中实现第 2 节指标、形态与 `--risk`，只加报告列，`--check` 不变。生成权威基线。
2. **双写。** 新增 `concerns.json`，`--check` 同时读取新旧两本账，两者认领的路径集合必须完全一致。不一致即迁移遗漏。
3. **切换。** 同一个提交中把 `--check` 切到 v2、启用 C3–C5、删除 `deltas.json`，并更新 [Upstream synchronization](../upstream.md) 中引用旧文件的段落。

验收：`--check` 在 v2 账本上通过；故意删掉一个 `rewrite` 理由或写错一个锚点时以 `1` 退出；无 `upstream` 远程时 `--risk` 以 `0` 退出；`npm run check` 通过。下一份同步记录写入第 4.2 节头部。

### WS-2 后台暂停外提

范围：`src/core/agent-session.ts`、`src/core/agent-session-runtime.ts`。

用重命名加薄壳替代 `try/finally` 包裹，使上游方法体缩进不变：

```ts
async compact(customInstructions?: string): Promise<CompactionResult> {
	return this._withBackgroundPaused(() => this._compact(customInstructions));
}

/** 上游方法体逐字保留，缩进层级不变。 */
private async _compact(customInstructions?: string): Promise<CompactionResult> { /* … */ }
```

适用于 `compact`、`_runAutoCompaction`、`reload`、`bindExtensions`、`navigateToEntry`、`_emitAgentSettled`，以及运行时的 `resume`、`newSession`、`fork`、`importFromJsonl`。

两处例外：

- `prompt()` 保留一次体内编辑：扩展命令分支可能长期挂起，不能持有暂停，须留在薄壳内、暂停之前；其余部分移入 `_promptModelInput()`。
- `_emitAgentSettled()` 同时恢复上游原有的延迟动作循环形状（`if (deferred.length > 0) { … return; }`）。

新增一条测试，断言上述十个操作都在暂停内运行，防止上游新增生命周期方法时静默漏掉。

验收：`agent-session.ts` 的 `reindent ≤ 20`（自 878）、`surface ≤ 400`（自 1164）；`agent-session-runtime.ts` 的 `reindent ≤ 10`（自 276）、`surface ≤ 80`（自 320）。两者仍可为 `rewrite`，因为真实的体内插入仍在，账本保留理由。

验证：`npm run test:isolated -- test/agent-session-background.test.ts test/suite/agent-session-compaction.test.ts test/suite/compaction-budget.test.ts`；真实 TTY 复核 compaction 的继续、取消、切点不可用、保留上下文失败与排队工作。

### WS-3 `interactive-mode.ts` 抽装配器

范围：把六件事抽到本仓自有文件：编辑器提交拦截、工具分组、选择器描述透传、终端监听作用域、发行版常量、canonical ExtensionContext。`interactive-mode.ts` 中每项只留一行挂载：

```ts
installEditorSubmitInterception(this);
installToolGrouping(this);
installDistributionHints(this);
```

验收：`surface ≤ 450`（自 730），`hunks ≤ 25`（自 44）；新增文件为 `own`。

验证：`npm run test:isolated -- test/interactive-tui.test.ts test/interactive-editor-submit.test.ts test/extensions-runner.test.ts`；真实 TTY 复核受影响的挂起、成功、错误、折叠、展开、分组与延迟进度状态。

### WS-4 `ui.editorHost` 收口

范围：`ExtensionUIContext` 上的 `onEditorSubmit`、`getEditorCursor`、`onTerminalInput` 的 `scope` 参数与 `TerminalInputOptions` 四处编辑，收成一个可选能力对象：

```ts
export interface EditorHost {
	onSubmit(handler: EditorSubmitHandler): () => void;
	getCursor(): { line: number; col: number } | undefined;
	onInput(handler: TerminalInputHandler, options?: { scope?: "editor" }): () => void;
}
```

`rpc-mode.ts` 不提供 `editorHost`，其 no-op delta 随之删除。BTW 改为检查宿主能力。

验收：`extensions/types.ts` 的 `hunks ≤ 12`（自 18）；`src/modes/rpc/rpc-mode.ts` 退出账本。

验证：`npm run test:isolated -- test/btw-extension.test.ts test/extensions-runner.test.ts`。

### WS-5 重定位

| 现位置 | 搬至 | 冲突面 |
| --- | --- | --- |
| `trust-manager.ts` 与 `resource-loader.ts` 的路径身份助手 | `src/utils/path-identity.ts`，上游文件只留调用点 | 83 → 约 12 |
| `model-config.ts` 的 `validateCompat` | Provider 扩展内，核心只导出三个 schema | 41 → 约 15 |

顺带把 `rewriteCmdNulRedirects` 从 `src/utils/shell.ts` 移到唯一消费者 `src/core/tools/bash.ts`。`usage-totals.ts`、`render-utils.ts`、`keybinding-hints.ts` 触碰极少，不动。

验收：目标文件冲突面达标且为 `patch`；`npm run test:isolated -- test/trust-manager.test.ts test/resource-loader.test.ts test/provider-compat-fields.test.ts` 通过。

### WS-6 键位注册接口

`KEYBINDINGS` 是核心常量且无注册接口，而 AGENTS.md 禁止硬编码按键检查。结果是扩展每要一条 `app.*` 绑定都得改一次核心，九个捆绑扩展里有四个因此耦合到核心，Question 仅因这一条。

范围：`KeybindingsManager` 支持运行时注册，扩展在激活时声明自身绑定；核心保留注册表、与保留绑定的冲突检测、用户配置覆盖。`app.backgroundTasks.*`、`app.btw.*`、`app.provider.*`、`app.list.toggle` 共 11 条移出核心。

验收：`AppKeybindings` 中不再有扩展私有条目；Question 扩展不再依赖核心改动；`npm run test:isolated -- test/keybindings.test.ts test/btw-extension.test.ts` 通过。

### 预期结果

按各项验收上限计：`rewriteSurface` 自 3403 降至约 2100 以下，总风险自约 222900 降至约 114000，减少约一半，几乎全部来自 WS-2 与 WS-3。实际结果以 WS-1 工具的测量为准。

## 6. 非目标

- **不以形态为 KPI。** 零触碰文件里的 `rewrite` 不产生成本；逻辑本就与上游交织时（如 `tool-execution.ts` 的 chrome 组装），硬拆只会让代码更难读。这类情况写 `rewrite` 理由即可。
- **不把风险做成闸门。** 它依赖 `upstream` 远程历史，只用于排优先级。
- **不 fork 上游库。** 只消费已发布 npm 包是当前最有价值的边界。
- **不把 `docs/**` 纳入形态管理。** 该目录归发行版所有，散文冲突由人解决。
- **不为减少 delta 撤销 Windows 修正。** 四条都有真实故障场景，正确动作是重定位或维持。

## 7. 实施记录

以 v0.87.1 基线、120 天窗口，由 `npm run diff:upstream -- --risk` 测得：

| 指标 | 实施前 | 实施后 |
| --- | --- | --- |
| 总风险 | 223400 | 60939 |
| `rewriteSurface` | 3770 | 1863 |
| `agent-session.ts` 冲突面 / 重缩进 | 1240 / 878 | 326 / 0 |
| `agent-session-runtime.ts` 冲突面 / 重缩进 | 320 / 276 | 67 / 0 |
| `interactive-mode.ts` 冲突面 / hunk | 730 / 44 | 117 / 25 |
| `extensions/types.ts` hunk | 18 | 9 |
| `trust-manager.ts` + `resource-loader.ts` 冲突面 | 83 | 18 |
| `model-config.ts` 冲突面 | 41 | 19 |
| `keybindings.ts` 冲突面 | 52 | 3 |

`rpc-mode.ts` 与 `utils/shell.ts` 恢复为上游原样，退出账本。总风险降幅（73%）大于第 5 节按验收上限估计的一半，因为 WS-2、WS-3 都明显优于上限。

与设计的偏离：

- **`touches` 只计非合并提交。** 合并提交会把同一改动重复计数；`git log` 单次调用即可求出全部路径。
- **形态与冲突面只度量 `src/`。** 文档、测试与打包文件由人合并，计入会让 `CHANGELOG.md` 之类的整体替换淹没排序。
- **账本迁移未做双写。** 新旧两本账都能单独通过覆盖与陈旧检查，一次性比对即可确认两者认领的路径集合一致（差异只有已恢复原样的两个文件），因此未实现临时双读。
- **`extension-model-runtime` 更名为 `extension-context`**，同时收纳陈旧上下文错误辅助函数。
- **WS-2：** 薄壳后的上游方法体统一命名为 `<方法名>Body`。`prompt()` 不需要 `_promptModelInput()`：暂停在扩展命令分支之后获取，并在上游原有 `try` 上追加 `finally` 释放；投递由定时器调度，释放与 `_runAgentPrompt()` 开始之间不会插入投递。`navigateTree` 本无重缩进，暂停仍在方法体内。原计划的结构性断言测试改为行为测试：扩展绑定、`agent_settled` 与会话替换钩子挂起期间，完成通知不得投递。
- **WS-3：** 自有模块为 `editor-host.ts`（`EditorHost` 实现）与 `tool-chat.ts`（清空时释放行的容器、分组折叠、分离提示）。分离快捷键整体移入捆绑的 background 扩展，`interactive-mode.ts` 不再持有它。`syntax-highlight.ts` 保留空实现的 `loadAllHighlightLanguages`，上游调用处无需改动。
- **WS-4：** `EditorHost.onInput` 始终限定编辑器焦点，不再带 `scope` 参数；不限定的输入仍用 `ui.onTerminalInput`。本发行版新增的扩展 API 类型集中在 `core/extensions/distribution-api.ts`，由 `types.ts` 一处转出。
- **WS-5：** 扩展只用到 `openai-completions` 一个 schema，核心只导出它。`rewriteCmdNulRedirects` 移入自有的 `shell-execution.ts` 而非 `bash.ts`，避免加大一个 `rewrite` 文件。
- **WS-6：** 扩展在模块加载时通过 `core/keybinding-registry.ts` 注册绑定并扩充 `AppKeybindings`，`main.ts` 静态导入捆绑扩展，保证先于任何 `KeybindingsManager` 创建；未新增 `ExtensionAPI` 方法。分离键让出的 `tui.editor.cursorLeft` 默认值也随 background 扩展注册。runner 的保留键列表仍含 `app.backgroundTasks.detach`。
- **C5 锚点与同步记录头部已在后续提交中删除。** 上游改名会表现为合并冲突、类型错误或覆盖测试失败，锚点只是重复这些信号；风险合计改为在同步记录中可选记录。

仍需真实 TTY 复核：compaction 的继续、取消、切点不可用、保留上下文失败与排队工作；工具行的挂起、成功、错误、折叠、展开、分组与延迟进度；分离快捷键；BTW 的提交拦截与编辑器内按键。
