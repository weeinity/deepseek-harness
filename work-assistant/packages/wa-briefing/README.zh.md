---
description: "为一个已配置 DSH home 创建定时个人助理简报 Session。"
kind: "package-bundle"
---

# 个人简报调度器

[English](README.md) | 中文

## Summary

为定时个人简报创建普通 DSH Session。五字段 cron 表达式和 IANA 时区定义触发时刻，按经过时间计算的前瞻窗口定义日历查询范围。每次运行都会挂载 `personal-assistant` preset，把模型可见工具限制为已配置的只读日历和记忆工具名，等待 Agent 进入 idle，刷新 Session 持久化，然后释放所拥有的 Agent。

## Contents

- [Configuration](#configuration)
- [Briefing runs](#briefing-runs)
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

调度器会跳过重叠触发，且不保存积压队列。它不会重试失败的工具调用、修改记忆、写日历、发送通知或发送邮件。卸载或超时时，它会取消所拥有的 Agent，等待 idle 收敛，刷新 Session，然后释放 handle。

<a id="model-experience"></a>
## Model Experience

### Scheduled prompt

#### Trigger

当调度器已启用且空闲时，到期的 cron tick 或对 `ctx.workAssistBriefing.trigger()` 的宿主调用会启动一次运行。

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
- 通知、邮件发送、日历写入和记忆修改不属于简报运行。
- 调度器面向单用户，不能隔离挂载在同一 profile 中的恶意插件。
