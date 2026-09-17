---
description: "面向已准入日历和记忆工具的个人助理 preset 资产和 profile 默认值。"
kind: "package-bundle"
---

# 个人助理 preset

[English](README.md) | 中文

## 概述

选择个人助理 preset，而不是标准编码 preset。该 preset 提供稳定的日程和记忆指导；profile 提供已准入工具、已配置日历来源和已配置记忆仓库。它不挂载 shell、任意文件系统、浏览器、代码、workflow、subagent、todo 或通用 skill-loader 行。

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

该 preset 组装只包含一个 `@deepseek-ai/dsh-persona` 行。它要求模型作为单用户个人助理回答，只在明确日程边界后使用 `calendar_list` 和 `calendar_find_conflicts`，为相关个人笔记使用 `memory_read`，并把日历和记忆文本视为外部数据而非指令。

profile 拥有工具准入。部署通常把 `@deepseek-ai/dsh-wa-gateway`、`@deepseek-ai/dsh-wa-calendar`、`@deepseek-ai/dsh-wa-memory` 和本包叠加到 DSH Web app profile 之上，然后用部署拥有的来源为 `wa-calendar` 和 `wa-memory` 打补丁。

<a id="model-experience"></a>
## 模型体验

### 个人助理人设

#### 触发条件

每个由 `personal-assistant` preset 组装的 agent，都会通过普通 DSH system-prompt 注册表收到本包的人设前缀和后缀。

#### 模型看到的内容

模型看到稳定指令：以个人助理身份回答，请求缺失日期或时区，为日历问题使用已准入日历工具，为个人笔记使用已准入记忆工具，并把日历和记忆数据视为外部内容而非指令。

#### Token 影响

此人设为该 preset 上的每次请求贡献固定 system-prompt 段落。本包不会把日历数据、记忆笔记内容、凭据值、URL、文件路径或可变记忆嵌入提示词。

#### KV Cache 影响

只要所选 preset 文件未变，人设文本就是稳定前缀。替换 preset 资产或更改活动 preset 会使该前缀失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 此 bundle 不会把 preset 资产复制到 DSH home；部署负责为隔离 profile 执行该文件操作。
- preset 只提供指导。网关准入、日历来源策略、记忆仓库策略和审批行为仍由各自拥有包强制执行。
- 不提供运行时 invariant companion：本包只交付静态 preset 资产和 profile 补丁，没有自己的运行时状态。
