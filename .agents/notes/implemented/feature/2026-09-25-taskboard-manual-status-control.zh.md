# Agent Note: Taskboard 手动状态控制

Status: implemented

[English](2026-09-25-taskboard-manual-status-control.md) | 中文

## Problem

看板列既是持久规划状态，也是执行投影。用户必须能够在不提交提示词或虚构执行历史的情况下修正或整理规划状态。

Todo 专属限制使最常见的新卡片无法通过看板进入 In Progress、In Review 或 Done。Client 还会在汇总视图和搜索筛选视图中禁用全部拖动，尽管跨列移动在任务自己的 Workspace 内仍有明确含义。

## Decision

每个活动任务都通过 `allowedManualStatuses` 暴露当前状态之外的全部状态。domain 使用常规修订与排序锚点验证接受每个目标。同列空操作与重新排序仍有效。

手动移动绝不提交工作、创建执行记录或更改对话。[执行驱动的列状态](2026-09-09-taskboard-execution-driven-columns.zh.md)继续根据关联的执行与用户处理需求证据移动任务，因此后续 Host 活动可能再次移动人工调整过的卡片。

Client 在单一 Workspace、“全部工作区”和搜索筛选视图中均保持活动卡片可拖动。在汇总或筛选视图中，跨列放置省略 `beforeTaskId`，并将任务追加到其自身 Workspace 内。同列重新排序与按卡片定位仅在未筛选的单一 Workspace 中可用。

整列均接受原生放置，包括列标题、空白区域和卡片。只有当前本地拖动的载荷才能移动任务；已取消或外部拖动不能修改任务。拖动过程中，目标列会高亮显示。移动尚未完成时会暂时禁用后续拖动，Client 仅显示 Host 已提交的位置。移动失败会保留该位置并显示错误。可选的 agent（智能体）公告描述相同的手动目标。

`taskboard/manual-status-not-allowed` Remote 错误及其本地化 Client 分支均不存在，因为任何有效手动目标都不会产生该失败。

## Alternatives considered

**保留 Todo 专属规则并显示反馈。** 这能解释拒绝原因，但仍会阻止用户在不运行任务的情况下修正规划状态。

**仅在 Web Client 中允许全部转换。** 其他 Client 或直接 Remote 调用者会观察到不同语义。domain 继续权威负责状态变更与公开目标。

**在汇总或筛选视图中重新排序卡片。** 混合 Workspace 与隐藏卡片会使一个显示位置含义不明。这些视图支持状态更改，但不支持排序。

## Testing

domain 与 controller 测试覆盖每个手动目标和独立复制的目标投影。组件测试覆盖整列放置、取消、载荷拒绝、等待保存、失败恢复和 Workspace 内排序。组装浏览器场景将任务移过每一列，执行筛选视图放置与同列排序，并在重新加载后验证已提交状态，且不派发工作。录制会话的 Run 场景固定可选的 agent 公告和手动状态控件。

## Consequences

用户可以独立于执行整理看板，而执行历史仍权威记录实际运行内容。自动观察可能随后再次移动卡片。汇总与筛选视图中的放置会在来源 Workspace 内追加，而不暗示全局顺序。
