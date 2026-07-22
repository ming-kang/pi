# Pi Fork 简要方案

## 定位

这是一个主要供自己使用、偶尔给朋友安装的 Pi Fork。

目标：

- 整体跟随上游 Pi 更新；
- 只维护 `packages/coding-agent` 的个人改动；
- 把当前 `pi-config` 中的扩展直接迁入仓库；
- 修改 Pi 原生工具展示，使 Pi-native 本身就是期望的样子；
- 保持实现直接、简单，不为暂时不存在的需求提前设计框架。

## 基本原则

1. 能直接实现就直接实现，出现真实重复后再抽象。
2. 不建立额外的 Fork 框架、feature registry 或统一配置系统。
3. 不新建额外 package，不重新设计整套 Extension API。
4. 扩展功能仍以扩展形式存在，只是静态内置到 `coding-agent`。
5. 只有扩展无法完成、或必须全局一致的行为才修改 Pi 本体。
6. 不以向上游提交 PR 为目标，只要求后续 merge 容易处理。

## 仓库范围

保留完整 Pi monorepo，Git 上游仍是完整仓库，但个人改动原则上只进入：

```text
packages/coding-agent/**
```

`pi-ai`、`pi-agent-core`、`pi-tui` 等其它 package 跟随上游，不主动修改。

## 最小目录结构

直接复用 Pi 已有的内置扩展目录：

```text
packages/coding-agent/src/
├── extensions/
│   ├── index.ts
│   ├── llama/
│   ├── deepwiki/
│   ├── question/
│   ├── todo/
│   ├── rewind/
│   ├── router/
│   └── statusline/
├── modes/interactive/components/
│   └── tool-execution.ts
└── core/tools/
```

不增加 `src/fork/`，不增加额外分层目录。

## 扩展迁移

现有扩展基本原样移动，例如：

```text
pi-config/extensions/deepwiki
→
packages/coding-agent/src/extensions/deepwiki
```

只做必要修改：

- import 后缀改为上游源码约定；
- 修正相对路径；
- 加入 `src/extensions/index.ts`；
- 原生展示已经足够时，删除不再需要的工具 renderer；
- 不在迁移过程中顺便大规模重构。

使用 Pi 已有的 `InlineExtension` 机制静态注册：

```ts
export const builtInExtensions = [
  { name: "llama.cpp", factory: llamaExtension, hidden: true },
  { name: "deepwiki", factory: deepwikiExtension, hidden: true },
  { name: "question", factory: questionExtension, hidden: true },
  { name: "todo", factory: todoExtension, hidden: true },
  { name: "rewind", factory: rewindExtension, hidden: true },
  { name: "router", factory: routerExtension, hidden: true },
  { name: "statusline", factory: statuslineExtension, hidden: true },
];
```

不使用 `fork.` 前缀，不额外实现开关系统；真正需要配置时再增加。

## 原生工具展示

“统一工具样式”指修改 Pi 原生工具展示路径，而不是创建新的 `tools-view` 扩展。

核心入口是：

```text
ToolExecutionComponent
├── 默认工具外壳
├── pending / success / error
├── 调用标题与参数
├── collapsed / expanded
├── generic fallback
└── 图片布局
```

目标视觉语言：

```text
● ToolName(args)
│ result
```

状态示例：

```text
● ToolName(args)       已完成调用
● ToolName Working...  正在执行
│ result               成功结果或摘要
● error                失败结果
```

实现原则：

- 直接修改 `tool-execution.ts`；
- 必要时调整 `core/tools/*.ts` 中的内置 renderer；
- 不重注册内置工具；
- 不修改工具执行逻辑、参数 schema 或结果结构；
- 先直接实现，只有确实出现重复时才抽出 `tool-presentation.ts`；
- 使用现有 Theme token，不硬编码颜色；
- 保留 Diff、代码高亮、图片和搜索结果等内置能力。

## 扩展工具如何继承

| 工具实现 | 行为 |
|---|---|
| 无 `renderCall` / `renderResult` | 完整使用新的 Pi 原生展示 |
| 自定义 renderer，使用默认 shell | 使用原生外壳，内部内容由工具提供 |
| `renderShell: "self"` | 工具继续完全自行绘制 |

因此：

- 自有扩展尽量使用 Pi-native 展示；
- 第三方扩展只要采用默认展示，就会自动获得新样式；
- 明确使用 `renderShell: "self"` 的第三方工具保持原有行为；
- 不强制覆盖第三方扩展明确提供的完整自定义 UI。

用户消息框不在当前范围内。

## 核心与扩展的边界

修改 Pi 本体：

- 原生工具外观；
- generic fallback；
- 必须全局一致的 TUI 行为；
- 未来确实遇到硬限制时所需的少量底层能力。

继续作为内置扩展开发：

- deepwiki；
- question；
- todo；
- rewind；
- router；
- statusline；
- 后续个人工作流功能。

即使都在同一个仓库，也不把这些功能揉进 AgentSession 或其它核心类。

## 上游更新

保持简单：

```bash
git fetch upstream
git merge upstream/main
```

个人改动主要是新增扩展目录，常见冲突预计集中在：

```text
packages/coding-agent/src/extensions/index.ts
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
packages/coding-agent/src/core/tools/*.ts
```

提交按实际功能拆分即可，例如：

```text
style(coding-agent): update native tool presentation
feat(coding-agent): bundle todo extension
feat(coding-agent): bundle question extension
```

不建立复杂分支或补丁管理流程。

## 构建与安装

沿用上游构建流程生成 Pi。

朋友需要安装时，优先提供 GitHub Release 中构建好的二进制；暂时不考虑：

- 新 npm scope；
- 多渠道发布；
- 自动更新服务；
- 复杂版本体系。

版本可简单使用：

```text
<upstream-version>-fork.<n>
```

## 明确不做

- 不恢复 `tools-view` 扩展；
- 不建立 `src/fork/` 框架；
- 不新建产品层 package；
- 不为所有功能设计统一 feature flag；
- 不添加暂时用不到的安全模式；
- 不为了“可能提交上游”而过度抽象；
- 不在迁移时重写已经工作的扩展；
- 不强制接管第三方 `renderShell: "self"` UI。

## 当前状态

已完成：

- 初始化并跟踪上游 Pi；
- 将默认工具展示改为 `●` 调用、`│` 结果、`●` 错误；
- generic 结果默认折叠为最近 10 个视觉行；
- `edit` 回归统一原生 shell，同时保留 Diff 预览；
- 将 deepwiki、question、todo、rewind、router、statusline 静态内置；
- 保留现有 `pi-config` 数据路径，避免丢失 router/rewind 配置；
- 完成类型、格式、组件测试和内置扩展加载 smoke 验证。

尚未执行：

- 完整 build；
- 完整测试套件；
- 真实终端中的所有 pending/success/error/collapsed/expanded 人工验收；
- 主题迁移；
- 停用外部 `pi-config`。

核心方向：

> 一个 Pi 仓库，少量本体修改，其余功能继续按扩展方式开发；先满足实际使用，再根据真实问题演进。
