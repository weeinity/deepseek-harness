---
description: "持久化 Taskboard 服务：基于 storage domain form、带修订检查与五列顺序的工作区任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-taskboard

[English](README.md) | 中文

## 概述

本包拥有持久化任务看板任务。每个任务包含稳定 UUID、Workspace、五态状态、rank、正修订号、时间戳、标签、优先级、可选的原生 DSH Session 关联，以及独立可选的 Agency Copilot CLI 会话标识。变更经服务串行化，并在操作队列槽位比较调用者的预期修订号，然后持久写入或移除单个任务行。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载 `dsh-storage`、一个存储后端、`dsh-storage-domain`、`dsh-workspace` 与本包。Web profile 把 `taskboard` domain 路由到 SQLite。消费者调用 `create`、`update`、`move`、`archive`、`delete`、`get` 与 `list`；归档任务保留最后的看板状态，默认隐藏。create 和 update 将内容与可选 Agency Copilot UUID 一起提交。调用者必须验证新选择的 Agency 标识属于任务 Workspace；[Taskboard controller](../../api/taskboard-controller/README.zh.md) 负责本地 Agency 发现。update 省略字段保留 Agency 关联，传入 `null` 清除关联，DSH Session 关联保持独立。专用、带修订检查的 `setAgencyCopilotSession` 方法支持宿主 Start/Clear 操作。version-1 磁盘 schema 验证可选 UUID。

`delete` 按预期修订号永久移除活动或已归档任务，并返回其 UUID 与 feed 的永久移除修订号 `Number.MAX_SAFE_INTEGER`。它绝不改变 Workspace、原生 DSH Session、Agency 会话或终端。任务缺失和修订冲突在存储写入前拒绝；存储失败保留记录，允许显式重试。取消可阻止排队中的删除开始，但已进行的存储删除正常完成。

<a id="model-experience"></a>
## 模型体验

### Taskboard 记录

#### 模型看到什么

无。`ctx.taskboard` 记录保留为宿主应用数据，本包不注册工具、prompt 或请求上下文贡献。

#### Token 影响

每次请求零直接 token。

#### KV Cache 影响

无；Taskboard 记录不进入提供方请求。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 修订 CAS 与变更观察是单进程的，因为通用 storage-domain 后端执行无条件行写入。
- 查询扫描权威内存表；索引分页与多进程 SQL CAS 需要专用关系型 provider。
- 在同一精确位置反复插入最终可能耗尽浮点 rank 间隙；rank 压缩延期处理。
- 删除当前保留记录中的最高序号后，新任务可复用该序号；记录由 UUID 标识，而不是序号。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
