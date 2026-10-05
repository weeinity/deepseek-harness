---
description: "为一个已配置 DSH home 创建定时个人助理简报 Session。"
kind: "package-bundle"
---

# 个人简报调度器

[English](README.md) | 中文

## Summary

无需发送聊天消息，即可在助理收件箱接收定时个人简报。五字段 cron 表达式和 IANA 时区定义计划。成功的只读日历简报在重新连接和重启后仍可查看。你可以暂停或恢复后续简报、标为已读、忽略消息，或打开其普通对话继续回复。

## Contents

- [Configuration](#configuration)
- [Briefing runs](#briefing-runs)
- [Inbox and pause](#inbox-and-pause)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## Configuration

插入的 `wa-briefing` 行默认禁用。启用时必须提供 `cron`、`timeZone`、`workspace`、`provider` 和 `model`；缺失或无效值会在插件加载时失败。cron 表达式必须正好包含五个字段。进程必须保持运行，触发时刻才会执行。

```yaml
- id: wa-briefing
  config:
    enabled: true
    cron: '0 9 * * *'
    timeZone: America/Los_Angeles
    workspace: C:\Users\you\assistant-workspace
    provider: deepseek-official
    model: deepseek-v4-flash
    includeMemory: true
```

运行限制由部署配置字段控制：`lookAheadMinutes`、`createTimeoutMs`、`turnTimeoutMs` 和 `maxPromptBytes`。[日历配置](../wa-calendar/README.zh.md#configuration)对交互调用和定时调用执行相同的结果数量限制。`includeMemory: true` 要求创建简报 Agent 时存在 `memory_read` 和 `memory_list`；`memory_write` 对简报 Agent 保持隐藏。

<a id="briefing-runs"></a>
## Briefing runs

每个到期运行都会创建一个根 Agent，设置 `meta.agentPreset: personal-assistant`，并把 `meta.cwd` 设为配置的工作区。setup hook 会先等待 `ctx.agentPresets.mount(agentCtx, 'personal-assistant')` 完成再发布，然后用精确的只读工具名调用 `ctx.tools.restrict()`。提示词是插件来源的用户消息，记录 `Window start`、`Window end` 和 `Time zone`，其中时间为 ISO instant，时区为 IANA 名称。

调度器跳过重叠触发，不保存错过执行时刻的积压队列。持久化的 UTC 分钟水位防止重复或更早的发生时刻再次启动 Agent。准入在创建前记录待处理 Session。重启只读取该待处理 Session：已成功持久化的回复无需新模型请求即可进入收件箱；不存在或未完成的运行不会重试。存储损坏会使启动失败，而不是清除待处理记录。

发布到收件箱需要已完成的轮次、未中断的助理文本、成功的 `calendar_list` 结果、没有失败工具，也没有介入的直接人类输入。仅 `whenIdle()` 不代表成功。发布收件箱前先刷新 Session 持久化。卸载、超时或暂停会取消所拥有的工作并等待释放。运行器不能提出交互问题、写入记忆或日历，也不能向 DSH 外发送消息。

<a id="inbox-and-pause"></a>
## Inbox and pause

[助理界面](../wa-ui/README.zh.md)独立于所选对话读取保存的收件箱状态。已读和忽略操作是明确的用户动作，不是推断的送达回执或动作审批。暂停跨重启保留，取消进行中的准备并阻止发布；恢复只允许未来的计划触发。`enabled: false` 的部署不能通过恢复按钮启用。

`maxInboxItems` 默认为 50（1–200），包含已忽略项目。`maxPreviewChars` 默认为 2000 个 Unicode 码点（1–8000）。旧收件箱项目按数量淘汰；完整 Session 日志遵循 DSH 保留策略，不随收件箱淘汰。发生时刻去重在淘汰后仍有效。策略与收件箱记录使用该 profile 的现有存储后端，命名空间为 `workassist_briefing`。

仅在 Web host 存在时注册 `GET` 和 `POST /api/work-assistant/briefing`。请求必须带 `x-dsh-assistant: 1` 和环回 Host（`localhost` 或 `127.0.0.1`）；POST 还要求匹配的 HTTP Origin 和有大小限制的 JSON 动作。端点只允许已读、忽略、暂停和恢复，不提供立即运行。它不支持代理来源或远程托管。

<a id="model-experience"></a>
## Model Experience

### Scheduled prompt

#### Trigger

当已启用、未暂停、空闲且发生时刻晚于持久化水位时，到期 cron tick 或受信宿主对 `ctx.workAssistBriefing.trigger()` 的调用会启动一次运行。

#### What the model sees

模型会看到个人助理 persona、包含精确窗口时间的定时提示词，以及 `calendar_list`、`calendar_find_conflicts` 和可选的 `memory_read`、`memory_list`。日历和记忆结果会声明外部内容是数据，不是指令。

#### Token effect

每次运行都会创建自己的 Session，并追加定时提示词、任何只读工具结果和助理简报。连接器限制工具结果大小。

#### KV Cache effect

对一个已配置 home，persona 和工具 schema 保持稳定。定时提示词会随每个触发时刻变化，因此运行特定的窗口 token 不形成可复用前缀。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 调度是进程本地能力。它不提供跨进程 exactly-once 保证；每个 DSH home 只运行一个实例。
- 进程停止期间错过的发生时刻会被跳过；没有补跑队列。
- 安静时段、日历变更检测、约定跟进、浏览器推送和外部送达暂缓。请把 Cron 配置在合适的本地时段。
- 崩溃可能留下没有收件箱项目的未完成发生时刻。恢复不会重新运行它；这不是 exactly-once 执行。
- 调度器面向单用户，不能隔离挂载在同一 profile 中的恶意插件。
