**上游差异预算规范，2026-09-22**

状态：提案，未实施。本页规定一套可执行的差异度量、账本格式与工具契约，以及六条工作流的验收标准。边界规则见 [AGENTS.md](../../AGENTS.md)，职责与耐久解释见 [Architecture](../architecture.md)，同步流程见 [Upstream synchronization](../upstream.md)。

实施完成后，第 2 至 4 节的规则移交 [Upstream synchronization](../upstream.md)，本页转为历史记录。它不应成为第三处规则来源。

## 1. 依据

### 1.1 前提

上游通常不接受新贡献者 PR。因此**每条 delta 都应按永久对待**，退休路径只剩"上游碰巧自行实现了等价机制"。现行 `deltas.json` 的 `bugfix` 与 `windows-compat` 类别隐含"上游修好即可退休"，在此前提下不成立：没有可观测的退休信号，它们就是永久的。

目标随之改变——不是减少 delta 数量，而是降低单位同步成本：

```
单位成本 ≈ 冲突面 × 上游触碰频率 × 失败被发现的难度
```

三个乘数都可测。冲突面靠耦合形态控制，检测难度靠断言、测试与符号级账本控制，频率可观测。**只测冲突面会选错目标**，这一点由下节数据直接证明。

### 1.2 形态分布

基线为 `upstream.json` 记录的源树 `e0fcee077666`，全过程只读。判据见第 2.2 节。

| 形态 | 文件数 | 冲突面 | 占比 |
| --- | --- | --- | --- |
| `rewrite` | 16 | 3403 行 | 85% |
| `graft` | 20 | 427 行 | 11% |
| `seam` | 13 | 185 行 | 5% |
| `own` | 237 | 0 行 | — |

`own` 按构造不产生冲突面，无论多大。`src/core/background/` 的 1754 行与九个捆绑扩展的一万八千余行都在这一档；它们不是维护负担，负担来自它们在上游文件里留下的挂载点。这是重定位策略的全部依据：把代码从 `rewrite` 移到 `own`。

### 1.3 风险乘积与分散度

频率窗口取基线之前四个月（2026-05-22 起至基线提交，2230 个上游提交）。风险乘积即冲突面乘触碰次数。分散度即 hunk 数，与行数独立——同样 76 行，集中在 2 个 hunk 与散在 18 个 hunk 的合并成本不同。

| 文件 | 冲突面 | 重缩进 | hunk | 上游触碰 | 风险乘积 |
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

### 1.4 结论

- **`agent-session.ts` 与 `interactive-mode.ts` 并列第一，比其余全部文件高一到两个数量级**，其余十四项合计不足前两者的 7%。不先处理这两个文件的计划是在优化噪声。
- `agent-session.ts` 与 `agent-session-runtime.ts` 的语义改动只有 330 行却产生 1484 行冲突面，其中 **1154 行是 `try/finally` 包裹后台暂停造成的整体右移**。这是唯一一笔既大又几乎无风险的回收。
- `interactive-mode.ts` 是窗口内被触碰最多的文件（139 次）且分散度最高（44 个 hunk）。仅按冲突面排序会把它排在末位。
- `keybinding-hints.ts` 零触碰、`render-utils.ts` 一次、`utils/shell.ts` 三次。**形态难看不等于成本高**：上游不碰的文件，其 delta 成本永远不会兑现。
- `extensions/types.ts` 冲突面仅 76 行却有 18 个 hunk 与 46 次触碰，比行数显示的危险。

## 2. 度量规范

### 2.1 指标

对基线 `B` 与路径 `p`：

| 指标 | 定义 |
| --- | --- |
| `add` / `del` | `git diff --numstat B -- p` 的两列 |
| `surface` | `add + del`，即冲突面 |
| `semantic` | `git diff -w --numstat B -- p` 两列之和 |
| `reindent` | `surface - semantic`，纯空白改动行数 |
| `hunks` | `git diff B -- p` 中 `^@@` 行数 |
| `touches` | `git rev-list --count --since=<窗口起点> <基线提交> -- <上游路径>`，在 `upstream` 远程历史上求值 |
| `risk` | `surface × touches` |

上游路径 = `sourceSubtree` 前缀加 `p`，前缀取自 `upstream.json`。

### 2.2 形态分类

四档，按顺序求值，首个匹配即结果：

```
own      ⟸ git cat-file -e B:p 失败（上游无此文件）
seam     ⟸ del == 0
graft    ⟸ del <= MAX_GRAFT_DELETIONS && reindent <= MAX_GRAFT_REINDENT
rewrite  ⟸ 其余
```

当前标定：`MAX_GRAFT_DELETIONS = 8`，`MAX_GRAFT_REINDENT = 10`。两个常量是策略选择，须在脚本中具名导出以便调整。

**不设 `wrap` 档。** 早期草案曾设，但它无法由 diff 统计判定——薄壳包裹在数值上与 `graft` 无异。它作为实现技术保留在 WS-2，不作为账本取值。四档全部机器可判定，没有留待人工裁量的缺口。

本页第 1.2 节的数字由该判据算出，是当前基线；若调整常量须同步重算并在同步记录中声明。

### 2.3 频率窗口

窗口由 `--window <天数>` 指定，默认 120 天，自基线提交的提交日期回溯。窗口必须与数字一同记录，否则跨同步不可比。

窗口是回溯估计而非预测。上游重构会改变分布，**每次同步应重新测量而非沿用本页数字**。

### 2.4 基线重算

第 1 节全部数字由一次性脚本得出。实施 WS-1 后，须以工具输出重新产生一遍并写入首份同步记录头部，该输出为权威基线。本页数字仅供论证，不得被工具硬编码。

## 3. 账本格式 v2

### 3.1 Schema

以关切为键，路径为挂载点。现行 `deltas.json` 以路径为键，导致 `src/core/agent-session.ts` 一条 `intent` 混入上下文快照、陈旧上下文失效、后台协调、nextTurn 持久化四件互不相干的事，且符号被上游改名时不会报错。

```jsonc
{
  "version": 2,
  "concerns": [
    {
      "id": "background-execution",      // kebab-case，唯一，稳定
      "why": "后台与前台 shell、Subagent 执行的监管、投递与有界保留。",  // 一句话
      "owner": "src/core/background/",   // 承载逻辑的本仓自有位置；无则空串
      "doc": "maintainers/architecture.md#ownership",   // 可选
      "retire": "permanent",             // 或 "watch:<可观测信号>"
      "attach": [
        { "path": "src/core/agent-session.ts", "form": "rewrite",
          "anchors": ["_backgroundHost", "_withBackgroundPaused"],
          "formExemption": "会话生命周期暂停必须跨越上游方法体；见 WS-2。" },
        { "path": "src/core/usage-totals.ts", "form": "seam",
          "anchors": ["getAccountedUsages"] }
      ],
      "tests": ["test/agent-session-background.test.ts"]
    }
  ]
}
```

字段语义：

- `form` — 取 `own`/`seam`/`graft`/`rewrite`，把接触方式从隐形属性变成受管控的一等属性。
- `owner` — 指向本仓自有位置。为空且该关切无 `own` 挂载点时，工具报告为重定位候选（警告，非失败）。
- `anchors` — 符号名替代散文。上游删除或重命名锚点时账本立即失败，而不是若干次同步后才发现行为已静默退化。
- `why` — 限一句话。长解释归 [Architecture](../architecture.md)，账本不兼任文档。
- `retire` — 取代 `category` 承载策略，仅两种取值。比 `bugfix` 诚实：没有 watch 信号的就是 `permanent`。
- 目录挂载点沿用末尾 `/` 约定。

### 3.2 校验规则

| 编号 | 规则 | 级别 |
| --- | --- | --- |
| R1 | 每条差异路径至少被一个挂载点认领 | 失败 |
| R2 | 声明 `form` 等于实测 `form` | 失败 |
| R3 | 每个 `anchors` 条目出现在该路径 diff 的增删行中 | 失败 |
| R4 | `form: "rewrite"` 必须带非空 `formExemption` | 失败 |
| R5 | `tests` 列出的路径存在 | 失败 |
| R6 | `id` 唯一且为 kebab-case；`retire` 形如 `permanent` 或 `watch:<非空>` | 失败 |
| R7 | `why` 为单句（无句号分隔的多句） | 警告 |
| R8 | 关切无 `own` 挂载点且 `owner` 为空 | 警告 |

R1 与 R5 是现行行为，保持不变。R2 至 R4 是新增闸门：把 `rewrite` 从默认状态变成需要书面解释的决定。

### 3.3 关切清单草案

63 条路径记录归并为 18 个关切：

`distribution-identity`、`bundled-extensions`、`background-execution`、`context-snapshot`、`compaction-trigger-percent`、`tui-fullscreen-default`、`tool-presentation`、`tool-grouping`、`extension-editor-host`、`extension-model-runtime`、`provider-editor-support`、`keybindings`、`windows-path-identity`、`windows-shell-normalization`、`windows-find-glob`、`windows-external-editor`、`auth-min-expiry`、`docs-and-tests`。

四条 Windows delta 拆成四个独立关切是有意为之：退休条件各不相同（`windows-find-glob` 依赖 fd 版本，其余三条无信号），合并成一个 `windows-compat` 会使 `retire` 失去意义。

## 4. 工具契约

### 4.1 命令

| 命令 | 行为 |
| --- | --- |
| `npm run diff:upstream` | 完整报告，增加 `form`、`surface`、`reindent`、`hunks` 列 |
| `npm run diff:upstream -- --check` | 对工作区执行 R1–R8；不访问网络，不计算 `touches` |
| `npm run diff:upstream -- --check --staged` | 同上，对索引求值（提交钩子使用） |
| `npm run diff:upstream -- --risk [--window <天数>]` | 输出 `touches` 与 `risk` 排名 |
| `npm run diff:upstream -- --target <tag>` | 现行行为，保持不变 |

退出码：`0` 通过，`1` 校验失败，`2` 用法或环境错误。

### 4.2 与提交钩子的约束

AGENTS.md 规定钩子不得抓取或改动引用。因此：

- `--check` **不得**依赖 `touches`。风险乘积只在 `--risk` 与完整报告中计算。
- `--risk` 在 `upstream` 远程历史缺失时输出"不可用"并以 `0` 退出，不得失败。它是排序工具，不是闸门。

这条约束决定了风险乘积不能进入 R1–R8。它用于人排优先级，不用于机器拦截。

### 4.3 同步记录头部

`maintainers/syncs/*.md` 增加机器可读头部：

```yaml
---
upstreamTag: v0.87.0
churnWindow: 2026-05-22..2026-09-22
conflictSurface: { rewrite: 3403, graft: 427, seam: 185 }
riskProduct: 222918
concernsTouched: []
concernsAdded: []
concernsRetired: []
---
```

`conflictSurface.rewrite` 是存量债务预算，每次同步后不得上升。**预算必须同时记录 `riskProduct`**：只记行数会重现本页初稿的误判——把零触碰的 `keybinding-hints.ts` 当成重构目标，把触碰最频繁的 `interactive-mode.ts` 排在末位。

## 5. 迁移程序

四步，每步独立可提交且提交钩子保持通过。

1. **实现度量，不设闸门。** 在 `scripts/diff-upstream.mjs` 中加入第 2 节的指标与分类，仅在完整报告中输出新列；`--check` 行为不变。实现 `--risk`。产出权威基线数字。
2. **双写账本。** 新增 `maintainers/concerns.json`（v2），工具同时读取它与 `deltas.json`，比对两者的 R1 覆盖结论必须完全一致。差异即迁移遗漏。
3. **切换并删除旧账本。** 在同一个提交中把 `--check` 切到 v2、启用 R2–R8、删除 `deltas.json`，并更新 [Upstream synchronization](../upstream.md) 中引用旧文件的段落。
4. **写入首份基线。** 按 4.3 格式在下一份同步记录中写入基线头部。

第 2 步是安全网：它让"账本改写是否漏掉了路径"成为一个可比对的事实，而不是人工复核。

## 6. 工作流

按风险乘积排序。每条给出范围、验收标准与验证命令。

### WS-1 账本与工具（1 天，前置）

范围：第 2 至 4 节全部内容，按第 5 节迁移。

验收：`npm run diff:upstream -- --check` 在 v2 账本上通过；对任一挂载点故意写错 `form` 或 `anchors` 时以 `1` 退出；`--risk` 在无 `upstream` 远程时以 `0` 退出；`npm run check` 通过。

它是前置项，不是因为最重要，而是因为缺少它时 WS-2 至 WS-6 的收益无法验证，也无法防止退化。

### WS-2 后台暂停外提（1–2 天，风险乘积约 76000）

范围：`agent-session.ts`、`agent-session-runtime.ts`。

做法是重命名加薄壳，使上游方法体缩进层级不变：

```ts
async compact(customInstructions?: string): Promise<CompactionResult> {
	return this._withBackgroundPaused(() => this._compact(customInstructions));
}

/** 上游方法体逐字保留，缩进层级不变。 */
private async _compact(customInstructions?: string): Promise<CompactionResult> { /* … */ }
```

适用于 `compact`、`_runAutoCompaction`、`reload`、`bindExtensions`、`navigateToEntry`、`_emitAgentSettled`，以及运行时的 `resume`、`newSession`、`fork`、`importFromJsonl`。

两处例外必须单独处理：

- `prompt()` 保留一次体内编辑。扩展命令分支可能长期挂起，不能持有暂停，该分支须留在薄壳内、暂停之前；其余部分移入 `_promptModelInput()`。
- `_emitAgentSettled()` 同时恢复上游原有的延迟动作循环形状（`if (deferred.length > 0) { … return; }`），当前改写为单个 `for` 循环是白送的冲突面。

验收：`reindent(agent-session.ts) ≤ 20`（自 878），`surface ≤ 400`（自 1164）；`reindent(agent-session-runtime.ts) ≤ 10`（自 276），`surface ≤ 80`（自 320）。形态可仍为 `rewrite` 并保留 `formExemption`——真实的体内插入依然存在，这是诚实的结果。新增一条测试断言这十个操作确实在暂停内运行，否则上游新增生命周期方法时会静默漏掉。

验证：`npm run test:isolated -- test/agent-session-background.test.ts`、`test/suite/agent-session-compaction.test.ts`、`test/suite/compaction-budget.test.ts`；真实 TTY 复核 compaction 的继续、取消、切点不可用、保留上下文失败与排队工作。

### WS-3 `interactive-mode.ts` 拆装配器（2–3 天，风险乘积约 41700）

范围：把散在 44 个 hunk 的六件事抽成本仓自有装配器——编辑器提交拦截、工具分组、选择器描述透传、终端监听作用域、发行版常量、canonical ExtensionContext。`interactive-mode.ts` 中每项只留一行挂载：

```ts
installEditorSubmitInterception(this);
installToolGrouping(this);
installDistributionHints(this);
```

验收：`surface(interactive-mode.ts) ≤ 450`（自 730），`hunks ≤ 25`（自 44）。新增文件形态为 `own`。

验证：`npm run test:isolated -- test/interactive-tui.test.ts test/interactive-editor-submit.test.ts test/extensions-runner.test.ts`；真实 TTY 复核受影响的挂起、成功、错误、折叠、展开、分组与延迟进度状态。

### WS-4 `ui.editorHost` 收口（半天，风险乘积约 966）

范围：`ExtensionUIContext` 上的 `onEditorSubmit`、`getEditorCursor`、`onTerminalInput` 的 `scope` 参数与 `TerminalInputOptions` 四处编辑，收成一个可选能力对象：

```ts
export interface EditorHost {
	onSubmit(handler: EditorSubmitHandler): () => void;
	getCursor(): { line: number; col: number } | undefined;
	onInput(handler: TerminalInputHandler, options?: { scope?: "editor" }): () => void;
}
```

`rpc-mode.ts` 不提供 `editorHost` 即可，其 no-op delta 随之删除。

验收：`hunks(extensions/types.ts) ≤ 12`（自 18）；`src/modes/rpc/rpc-mode.ts` 退出账本；BTW 改为检查宿主能力而非调用可能不存在的方法。

验证：`npm run test:isolated -- test/btw-extension.test.ts test/extensions-runner.test.ts`。

### WS-5 重定位（半天，风险乘积约 740）

只做风险乘积最高的两项：

| 现位置 | 搬至 | 冲突面 | 风险 |
| --- | --- | --- | --- |
| `trust-manager.ts` 与 `resource-loader.ts` 的路径身份助手 | `src/utils/path-identity.ts`，上游文件仅留调用点替换 | 83 → 约 12 | 687 |
| `model-config.ts` 的 `validateCompat` | Provider 扩展内；核心仅导出三个 schema | 41 → 约 15 | 656 |

其余四项（`usage-totals.ts` 309、`utils/shell.ts` 69、`render-utils.ts` 19、`keybinding-hints.ts` 0）**不做**，在账本中记 `formExemption: "低触碰，暂不重定位"`。全部六项合计风险 1740，不到 `agent-session.ts` 单个文件的 2%；搬迁后三项只是让报告数字好看。

`rewriteCmdNulRedirects` 的唯一消费者是 `src/core/tools/bash.ts`，`src/utils/shell.ts` 本不需要被修改——顺手改正即可，不单列工作项。

验收：两个目标文件形态与冲突面达标；`npm run test:isolated -- test/trust-manager.test.ts test/resource-loader.test.ts test/provider-compat-fields.test.ts` 通过。

### WS-6 键位注册接口（半天，风险乘积约 364）

`KEYBINDINGS` 是 `src/core/keybindings.ts` 中的常量且无注册接口，而 AGENTS.md 禁止硬编码按键检查。两条规则叠加，使任何扩展想要一条 `app.*` 绑定就强制一次核心编辑——九个捆绑扩展里有四个因此被绑定到核心，其中 Question 仅因这一条。

范围：`KeybindingsManager` 支持运行时注册，扩展在激活时声明自身绑定；核心保留注册表、与保留绑定的冲突检测、用户配置覆盖解析。`app.backgroundTasks.*`、`app.btw.*`、`app.provider.*`、`app.list.toggle` 共 11 条移出核心。

验收：`AppKeybindings` 中不再有扩展私有条目；Question 扩展对核心的依赖降至零；`npm run test:isolated -- test/keybindings.test.ts test/btw-extension.test.ts` 通过。

### 预期结果

全部完成后 `rewrite` 冲突面自 3403 降至约 1955，总风险乘积自约 222900 降至约 103500（减少五成四）。**九成以上的回收来自 WS-2 与 WS-3**；WS-4 至 WS-6 合计不足 2%，保留它们是因为各自还有风险乘积之外的收益——删除 delta、解除扩展对核心的绑定——而不是因为数字。

`src/core/tools/bash.ts` 风险乘积 4556 排第三却不在计划内：其重缩进仅 24 行，其余是后台交接对上游内联执行路径的真实替换，`shell-execution.ts` 已承接可外移的部分，余下基本不可约。若上游日后自行抽出 shell 执行层，应优先重估。

## 7. 非目标

- **不把形态当作 KPI。** 零触碰文件里的 `rewrite` 不产生成本（`keybinding-hints.ts` 即是）；逻辑本就与上游交织时（`tool-execution.ts` 的 chrome 组装即是），硬拆会造出更难读的代码。`formExemption` 就是为这两类例外留门。排序看风险乘积，不看形态。
- **不 fork 上游库。** 只消费已发布 npm 包这条边界是当前最有价值的约束，破坏它会使维护成本由线性转为指数。
- **不把 `docs/**` 纳入形态管理。** 该目录本就归发行版所有，散文冲突由人解决。
- **不为使数字好看而合并关切。** 十八个各自一句话说得清的关切，优于六个重新退化为散文段落的条目。
- **不因减少 delta 而撤销 Windows 修正。** 四条各有真实故障场景，正确动作是重定位或维持，而非撤销。
- **不把风险乘积变成闸门。** 它依赖 `upstream` 远程历史，而提交钩子不得抓取引用；它用于人排优先级。
