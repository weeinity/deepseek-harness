# Agent Note: Conversation View 的精确 Session 可见性

Status: implemented

[English](2026-09-12-session-exact-conversation-visibility.md) | 中文

## 问题

可选的 Conversation View 可能只适合选定聊天，而不属于每个聊天或其 subagent。单独的全局 Slot 条目无法表达这种选择。Tab 渲染、持久化选择和程序导航必须在每个存活 Session binding 上保持一致。

## 决策

`UiConversation.visibility` 为每个 View id 持有一个可选的可观察 Session-id 允许列表。注册策略只允许值严格等于 `true` 的确切条目；没有策略时 View 保持不受限制。策略可以先于 Slot 条目注册，并与 source 取消订阅一起归属于注册插件的 Cordis effect。

Shell 为每个 `SessionBinding` 投影稳定的可见列表，供 header 和 body 共用。Slot、locale 和策略变化刷新所有存活列表。Binding 替换和释放只移除该 binding 持有的记录，因此延迟的旧清理不会移除 Session id 相同的新记录。隐藏的偏好 View 回退到可见 Chat，但不丢失偏好。Shell 导航与直接激活 target 在新激活前检查可见性；已激活 target 保持 assembler 的单调生命周期。

[Session 与 Conversation 所有权决策](2026-08-20-client-session-conversation-ownership.zh.md) 仍定义数据所有权和标准 source。本策略增加呈现过滤，不转移这些职责，也不改变全局 Slot 列表。

## 考虑过的替代方案

**隐藏 DOM 元素。** 视觉上移除 tab 无法阻止偏好恢复、focus 请求或 target 激活，也无法保证 body 与 header 一致。

**根据当前 Session 变化注册或注销全局 View。** 全局列表无法表达两个存活 Session 的不同选择。导航还会转移另一个插件 contribution 的所有权。

**继承父 Session 的启用设置。** 精确的逐聊天启用不包含 child Session，除非 child 有自己的显式条目。血缘不是权限。

## 后果

可选 View 的所有者提供并持久化自己的策略 source；框架不持有功能设置或全局单例。移除策略会恢复不受限制的行为，因此同时持有 View 的插件先移除 Slot 条目，再移除策略。可见性不是数据授权、取消操作或 target 停用。

聚焦的接线和 registry 测试覆盖不受限制的 View、精确的父子隔离、同时存活的 binding、隐藏导航、响应式偏好恢复、标签、卸载和同 id binding 替换。浏览器组合仍由消费者验证，因为默认发布的 View 都未启用此策略。
