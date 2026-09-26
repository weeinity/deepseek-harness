---
description: "在关联的 DSH 或 Copilot 对话中运行已保存的 Taskboard 任务、监控执行历史，并安排由宿主执行的工作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-taskboard-controller

[English](README.md) | 中文

## 概述

无需保持浏览器打开即可运行已保存的任务。重复运行会继续任务唯一关联的 DSH 或 Copilot 对话，并保留独立的执行记录。你可以使用明确时区安排工作、在重连后检查失败，并在看板上跟踪执行进度和用户输入请求。可选设置向智能体说明 Taskboard 规则，并请求防止空闲睡眠。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[Web 应用包](../../bundle/web-app/README.zh.md) 将本 controller 与其 Session、Session 投影、LLM、Workspace、settings 和传输服务一起挂载。固定任务模型和预设需要 LLM 和 Session 投影服务。展示包注入无 React 的 Client `taskboard` 服务，而不是直接调用传输层。

<a id="execution-and-connections"></a>
### 执行与关联

创建任务时可以关联现有对话，也可以由 Run 为其保留首个对话标识。Run Again 继续使用同一标识。更换对话前必须断开关联；对话缺失是错误，不代表可以重建。Connect 和 Open 不提交提示词。Copilot 选择通过有界 Agency 发现验证规范化 Workspace 归属；发现不完整或不可用时仍会显示失败。

Run 提交已保存的运行提示词；提示词为空时使用标题和非空白描述，并附加已冻结的交接上下文。未固定的 DSH 设置保留关联 Session 的选择。任务专用模型选择不会改变未来 Session 的默认模型。Copilot 默认为只读；提高权限需要已保存的确认。计划信息编辑保留修订检查。

新任务默认为 Todo。接受运行后移到 In Progress；等待用户输入、失败或取消会使任务移到 In Review。恢复执行后回到 In Progress，经关联证据确认成功完成后移到 Done。未归档任务可手动移至任意列，且不会运行任务；仍可在同列内重新排序。已有记录及创建时明确指定的状态保持不变。

在关联的 DSH Chat 中直接继续对话，而不使用 Run，其中的问题和审批也会使任务移到 In Review，包括没有执行历史的任务。打开关联 Session 即可回答；恢复工作后进入 In Progress，提出问题的确切轮次结束结果决定进入 Done 还是 In Review。此监控不创建或修改执行记录。未关联的 Chat 和已归档任务保持不变。

开始写入执行记录前会检查调用方取消信号。接受后，即使浏览器断开连接，执行仍由宿主负责。Controller 关闭会取消发现操作，并等待已接受的操作结束。

归档和删除会拒绝尚未结束的执行。恢复任务后计划保持禁用。复制会创建独立任务，不保留关联、执行历史或权限确认。归档后仍可通过当前及保留历史中的关联导航到对话。删除任务不会停止或删除其对话。

### 宿主设置

三个 Taskboard 开关通过普通 `taskboard` 用户设置节覆盖组合默认值。Taskboard 禁用时仍可编辑设置。`agencyCopilotLaunch` 仅属于部署配置。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 接受手动和计划工作；禁用不会删除对话。 |
| `announceToAgent` | `false` | 在后续 DSH 模型请求中包含 Taskboard 指引。 |
| `preventIdleSleep` | `false` | Session 运行或计划启用时请求保护。 |
| `agencyCopilotLaunch` | `false` | 在符合条件的部署中允许本地 Copilot 执行和终端导航。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-taskboard-controller) 负责列出部署超时、恢复上限、锁目录和初始计划时区。五字段 cron 在每个任务中保存时区。启动和较长时钟间隔会跳过错过的执行时点；忙碌任务或对话不会积累补执行队列。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

宿主在提交输入前持久保存执行意图和 provider 游标。恢复过程只观察已保存的标识和回执，不重发接受状态不确定的提示词。准入、等待用户处理和终态观察会随执行记录原子更新任务所在列；等待不会结算执行。内核持有的锁排除另一个配置相同的宿主，并在进程死亡时释放；时间戳陈旧绝不构成抢锁依据。宿主取得锁后重新加载任务状态，在修改前验证所有权，并在关闭期间持锁至已接受的写入结束。

不存在未结束执行时，关联 Chat 的监控保留实时 Agent 与提问轮次，不借用既往执行回执。经过修订检查的列写入保留任务输入和历史。断开关联、归档、删除和接纳新执行会使借用的监控失效，包括断开后重连的竞态。禁用新的 Taskboard 运行不会停止用户处理需求监控。

重连 baseline 包含活动与已归档任务，以及运行时设置、调度器和电源观察结果。带修订的回显不能替换较新任务。永久移除 tombstone 防止延迟响应恢复已删除标识。业务失败保留 `taskboard/*` Remote 错误码和类型化详情；Client 命令失败保留原始 Remote 错误。

宿主像 Session 和 Workspace controller 一样，将其服务依赖保留为 peer。不发布伴生入口。调度与生命周期检查负责执行安全，而周期性断言无法证明外部对话已经完成。

| 源码 | 职责 |
|---|---|
| [Controller](src/index.ts) | Remote 命令、关联验证与终端导航。 |
| [协调器](src/runtime/coordinator.ts) | 接受执行、调度与回执核对。 |
| [DSH adapter](src/runtime/dsh.ts) / [Copilot adapter](src/runtime/copilot.ts) | provider 输入与完成证据。 |
| [宿主生命周期](src/runtime/index.ts) | 设置、所有权与空闲睡眠保护需求。 |
| [Feed](src/feed.ts) | 重连 baseline 与有序观察结果。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Taskboard domain](../../workspace/taskboard/README.zh.md)：持久输入与修订规则。
- [Taskboard UI](../../client/ui-taskboard/README.zh.md)：任务编辑、历史和设置。
- [Taskboard 子系统](../../../docs/subsystems/taskboard.zh.md)：共享类型与生成的 API。

<a id="model-experience"></a>
## 模型体验

### 任务执行与可选指引

#### 模型看到什么

每次接受的运行向关联 provider 提供一条普通用户输入，并在存在交接文本时包含它。DSH 将输入写入 Session 日志；Copilot 负责其对话历史。可选 DSH system-prompt 指引以 `Taskboard keeps saved task definitions, connected conversations, and execution history.` 开头。关联与导航不添加输入，本包也不注册 Taskboard 模型工具。

#### Token 影响

每次接受的运行增加一条与提示词等长的用户输入，以及冻结交接文本和启用时的可选 system 节。

#### KV Cache 影响

运行扩展现有对话前缀。改变可选 system 节可能使缓存前缀失效；任务专用模型更改仅作用于对应 Session。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

宿主必须保持可用，才能调度和监控工作。

- feed 属于单一权威宿主，而非多进程协作服务。共享任务数据的宿主必须使用相同锁位置。
- 恢复不保证外部效果恰好一次，不自动重试提示词，也不通过 Taskboard 取消借用的对话。无法证明的结果保留为明确失败或监控诊断。
- 等待检测使用当前挂载 adapter 观察到的类型化问题与审批请求，不推断智能体文本。重新加载 adapter 后无法确定已有等待的执行归属。具有关联证据的待定动态包审批会延后发布原始轮次的成功；后续 system-steering 轮次不属于该次执行。无人值守 Copilot 会拒绝不支持的交互请求，并在 In Review 记录失败执行，而非假装人工回复可以恢复它。
- 无法确认 provider 已关闭时保留宿主锁。启动另一个宿主前须重启持锁进程；不要删除其锁文件。
- Copilot 执行与终端导航保留本地 Windows 部署限制。执行使用 SDK 固定的 CLI 运行时，而非 PATH 上的任意可执行文件，并要求原生 Copilot CLI 已登录；不会继承 Agency 的认证和启动注入。Run 前须关闭占用所选对话的交互式 CLI；Taskboard 绝不抢占其所有权。[隔离互操作测试](tests/copilot-interop.e2e.ts) 负责提供运行时兼容性证据；不支持的权限或恢复操作会失败，而非削弱策略。
- 空闲睡眠保护不安排唤醒，也不保证手动睡眠、合盖、关机或断电期间继续运行。已启用计划可能需要持续保护。
- Agency 发现最多读取十页，每页 100 个会话，并可能产生正常 CLI 启动副作用。`truncated: true` 区分未完成扫描与确认缺失。
- Workspace 删除会隐藏保留的任务记录；恢复任务不会恢复已移除的 Workspace。重连使用完整 baseline，而非持久 feed 游标。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
