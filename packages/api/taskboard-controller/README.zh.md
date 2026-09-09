---
description: "Taskboard Remote controller：向 Web 客户端提供带修订检查的命令与可重连任务状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-taskboard-controller

[English](README.md) | 中文

## 概述

本包通过生成的 `taskboard` Typert Remote namespace 暴露宿主 Taskboard，并提供无 React 的 Client model。create、update、move、archive、delete 与 Agency Copilot 关联的一元调用立即安装回显；可重连流在每个物理 generation 开始时发送完整任务 baseline，随后应用有序 upsert/remove 增量。其仅宿主 Agency adapter 验证所选本地 Copilot 标识、为 Start 生成新标识，并以固定 Windows Terminal 参数执行交接，不接受浏览器提供的命令、路径、flag 或环境。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `dsh-taskboard`、API Gateway、Connection、API Remotes 和本地 subprocess provider 一起挂载。展示包注入 Client `taskboard` 服务并订阅其身份稳定的 snapshot，而不是直接调用 transport。`startAgencyCopilot` 先持久保存宿主生成的 UUID，再在任务 Workspace 中把 `agency copilot --session-id <uuid> --interactive <task>` 交给 Windows Terminal。初始提示词包含持久保存的标题，并在描述非空时追加一个空行和描述；Copilot 的正常工具审批保持启用。`openAgencyCopilot` 会报告已运行会话、以 `--resume=<uuid>` 恢复已观察为 idle 的会话而不再次提交提示词，或在完整扫描证明首次启动未产生会话时用当前任务内容重试同一 UUID。Agency 状态失败与持久任务加载保持独立。

`listAgencyCopilotSessions` 返回规范化文件夹与已注册 Workspace 匹配的现有本地会话，包含可选摘要和 idle/in-use 状态，但不返回文件夹路径。create 和 update 仅在宿主于任务 Workspace 中发现完全匹配的 Agency 记录后接受所选 UUID；内容与关联一起提交。选择会话不会启动或恢复 Copilot、提交提示词或改变计划状态。DSH Session 关联保持独立。省略或保持 Agency 关联不变无需发现；update 传入 `null` 清除关联。关联更新与归档/Start/Open/Clear 共用任务锁，并在发现后重新检查修订 CAS。取消可阻止排队中的写入开始。

列表和重连 baseline 包含已注册 Workspace 中的活动与已归档任务。归档提交以 upsert 到达，刷新后仍保留在 Client snapshot 中；`archivedAt` 区分归档记录，但不改变其计划状态。展示包从活动看板和 Agency 刷新请求中排除归档记录。已归档任务拒绝内容、移动、关联和 Copilot 启动操作；Client 丢弃其临时 Agency 观察结果，包括延迟响应。延迟回显或 baseline 不能回退任务修订。完整 baseline 移除缺失记录，任务记录或 Workspace 删除则发出移除 tombstone。

`delete` 按预期修订号永久移除活动或已归档的 Taskboard 记录，不改变其 Workspace、原生 DSH Session、Agency 会话或终端。它共用任务的 Agency 操作锁，并在允许持久删除前检查取消状态。Client 仅在成功后移除记录与其 Agency 观察结果；Remote 失败或请求拒绝保留现有状态，不自动重试。移除回执和 feed tombstone 使用 `Number.MAX_SAFE_INTEGER`，防止延迟任务回显、baseline 或 Agency 观察结果恢复已删除标识。

<a id="model-experience"></a>
## 模型体验

### Taskboard 传输

#### 模型看到什么

新启动的外部 Copilot 会话收到任务标题和描述，作为初始用户消息。选择现有会话不发送消息。Copilot 负责该对话的日志；关联的 DSH Session 不会收到消息。`taskboard` Remote 不注册 DSH 工具或请求上下文贡献。

#### Token 影响

每次新建外部 Copilot 会话提交一条与任务内容等长的用户消息。不增加 DSH 请求 token。

#### KV Cache 影响

不改变 DSH 缓存。外部 Copilot 会话把提交的任务加入其自身对话历史。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 重连以完整 baseline 修复状态，而不是使用持久 cursor。
- feed 反映单一权威宿主进程；storage-domain 变更不是跨进程通知。
- Workspace 删除会从列表和流中隐藏其活动与已归档任务，但保留持久任务记录。controller 不提供恢复命令。
- Windows Terminal 交接仅证明 broker 接受了请求；需要刷新 Agency 状态才能观察 Copilot 是否取得会话。
- 任务提交受 Windows 命令行长度限制。过大的提示词会显式失败而不是被截断；缩短任务标题或描述后再重试。
- Agency 状态发现以有界输出运行已安装 CLI，因此仍会产生 Agency 正常的调用日志与启动副作用。
- 发现最多读取十页，每页 100 个会话。`truncated: true` 表示仍有未读取页；无法选择不完整扫描中缺失的标识。Agency 数据格式错误或发现不可用时会显式拒绝，而不是返回空列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
