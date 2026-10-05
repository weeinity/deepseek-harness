---
description: "面向已准入日历和记忆工具的个人助理 preset 资产、作用域问题和 profile 默认值。"
kind: "package-bundle"
---

# 个人助理 preset

[English](README.md) | 中文

## 概述

选择个人助理 preset，而不是标准编码 preset。该 preset 提供稳定的日程、记忆和聚焦问题指导；profile 提供已准入工具、已配置日历来源和已配置记忆仓库。它不挂载 shell、任意文件系统、浏览器、代码、workflow、subagent、todo 或通用 skill-loader 行。

## 目录

- [配置](#configuration)
- [Preset 资产](#preset-asset)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## 配置

仅在后续隔离的个人 profile 中安装此 bundle。它的补丁把 `agent-presets` 行改为 `default: personal-assistant`，通过 `includeShippedRoot: false` 禁用随发行版提供的 preset，并保留 DSH home 用户 preset 根目录。

部署步骤必须在启动 profile 前，把本包的 `presets\personal-assistant` 目录复制到 `$DSH_HOME\.agent-presets\personal-assistant`。不要为了凑齐五个 bundle 的草图而添加通用 skill 或文件系统 loader；此 preset 自己拥有人设文本，日历访问来自 `wa-calendar`，记忆访问来自 `wa-memory`。

<a id="preset-asset"></a>
## Preset 资产

该 preset 组装包含 `@deepseek-ai/dsh-persona` 和本包提供的一个作用域交互行。它要求模型作为单用户个人助理回答，仅在已明确日程边界后用 `calendar_list` 和 `calendar_find_conflicts` 读取已配置日历，在笔记可解析上下文时先使用 `memory_read` 再询问，并把日程安排视为只起草。

作用域交互行会加载已发布的 `@deepseek-ai/dsh-tool-ask-user` 包，并且只通过 `wa-gateway` 准入它的精确 `ask_user_question` 定义。profile 拥有用户问题答复器和工具准入。部署通常把 `@deepseek-ai/dsh-wa-gateway`、`@deepseek-ai/dsh-wa-calendar`、`@deepseek-ai/dsh-wa-memory` 和本包叠加到 DSH Web app profile 之上，然后用部署拥有的来源为 `wa-calendar` 和 `wa-memory` 打补丁。

Cordis、作用域和工具服务由 Host 作为对等依赖提供。安装私有运行时副本可能使 preset 与其 Agent 使用不同的作用域身份，导致组装失败。

<a id="model-experience"></a>
## 模型体验

### 个人助理人设

#### 触发条件

每个由 `personal-assistant` preset 组装的 agent，都会通过普通 DSH system-prompt 注册表收到本包的人设前缀和后缀，并在 `ctx.userQuestions` 可用时收到作用域内的 `ask_user_question` 工具。

#### 模型看到的内容

模型看到稳定指令：以个人助理身份回答，用已准入只读工具准备，通过 `ask_user_question` 请求重要选择，把日程安排视为只起草，并且只报告已验证结果。对于无需回答或行动的感谢或低风险近况，模型可以偶尔仅用竖拇指表情回应；问候、问题、实质请求、困扰和确认决定则需要文字或实际工作。表情并非自动添加，也不授予审批。模型还会看到 `ask_user_question` 返回已选择的选项标签和可选自定义文本，而不是隐藏审批 id。

#### Token 影响

此人设为该 preset 上的每次请求贡献固定 system-prompt 段落和已发布 ask-user 工具 schema。本包不会把日历数据、记忆笔记内容、凭据值、URL、文件路径或可变记忆嵌入提示词。

#### KV Cache 影响

只要所选 preset 文件和已安装 ask-user 包未变，人设文本和 ask-user schema 就是稳定前缀。替换 preset 资产、更改活动 preset 或更改 ask-user 包会使该前缀失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 此 bundle 不会把 preset 资产复制到 DSH home；部署负责为隔离 profile 执行该文件操作。
- preset 只提供指导和作用域内用户问题准入。网关连接器准入、日历来源策略、记忆仓库策略和写入审批行为仍由各自拥有包强制执行。
- 不提供运行时 invariant companion：运行时 effect 派生自 DSH 工具注册表和网关的精确定义守卫，没有可独立比较的状态。
