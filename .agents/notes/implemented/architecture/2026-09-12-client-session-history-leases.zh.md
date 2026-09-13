# Agent Note: Controller 拥有的精确 Session 历史租约

Status: implemented

[English](2026-09-12-client-session-history-leases.md) | 中文

## 问题

独立读取者需要精确 Host Session 的原生历史与实时 Assistant 状态，但不能替换应用当前选中的 Session。单独解析 binding 只能得到冷 event source。通过导航打开该 source 会改变无关 UI 状态，而另建传输又会重复 controller 的历史协调逻辑。

## 决策

[Session Controller](../../../../packages/api/session-controller/README.zh.md#client-history-leases) 拥有 `ISessions.retain(sessionId, signal?)` 与 `SessionLease`。获取租约会打开现有原生 Session，并在 follow baseline 安装后完成。多个租约共享相同 binding 与 source。Root Session 可以不在 Client 列表中，但必须满足既有 Host 地址与历史读取资格规则，包括 header cwd。租约不会让原本不可读的 Session 变得可访问。

导航是历史的常驻 owner：切换离开不会关闭它打开的历史。租约在不改变此行为的前提下增加独立、有界的所有权。最后一个仅由租约持有的 owner 会释放历史窗口、取消其读取，并等待 iterator 与 page 操作完成；它不会取消 Agent 工作。仍在列表中的 binding 在释放读取后保留，而不在列表中的仅租约 scope 随最后一个 owner 退出。Generation 检查阻止已释放的读取修改后续 owner 的状态。

调用方取消只释放该租约，包括已就绪之后。显式移除普通 Session 或销毁 controller 会结束租约；列表刷新遗漏某 id 则不会。打开错误会拒绝获取操作，后续 follow 错误仍保留在原生 Session snapshot 中。就绪既不表示完整历史已加载，也不表示 Agent 已完成。

## 考虑过的替代方案

**通过选中 Session 来打开它。** 这会让独立读取修改全局导航，并排除必须让私有 Session 留在普通 current 视图之外的消费者。

**暴露具体 `Session.open()` 或创建另一个 follow stream。** 裸 open 没有负责释放的 owner，另一个 stream 又会重复已有 Assistant settlement 与连续性处理。公开租约只暴露原生 binding 与释放操作。

**每次 selection 改变都关闭导航历史。** 这会改变既有的离屏更新与 scope 生命周期。常驻导航所有权保持独立于可释放的读取者所有权。

## 后果

Client API 增加的是资源生命周期，而不是另一套传输或 Conversation renderer。调用方必须释放租约并停止使用已释放 binding。导航打开的历史持续保留到原有 scope 清理时；租约释放不能回收另一个 owner 的 source。

[聚焦测试](../../../../packages/api/session-controller/tests/session-lease.client.spec.ts)通过真实 Client Session、Gateway journal 与可编程 Remote，验证双 Session 隔离、共享就绪、导航共享、取消、移除、失败、进行中 page 的隔离及静止态清理。该 Remote 不验证 Host header 或地址资格。私有 GUI 组合与真实模型 transcript 证据属于消费此 API 的面板，而非此数据层 API。

## 相关决策

[Client 所有权决策](2026-08-20-client-session-conversation-ownership.zh.md)继续负责 Controller、Conversation 与 renderer 分层。[Scope 对等决策](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)继续负责 Agent 身份与 scoped effect；租约扩展其由列表驱动的 scope 资格，而不替换这些规则。[传输决策](2026-08-18-session-history-and-event-transport.zh.md)继续负责 Remote 生命周期与协调逻辑。没有任何一篇被完全取代。
