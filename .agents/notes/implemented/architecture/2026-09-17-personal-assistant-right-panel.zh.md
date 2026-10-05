# Agent Note: 个人助理右侧面板

Status: implemented

[English](2026-09-17-personal-assistant-right-panel.md) | 中文

## Problem

个人助理 profile 需要在会话旁显示身份和活动，包括第一条消息之前。另建活动数据库或根据空闲 Agent 推断任务列表，会误述助理实际完成的工作。修改共享 Web 应用还会影响无关的编码 profile。

## Decision

[wa-ui bundle](../../../../work-assistant/packages/wa-ui/README.zh.md) 只在安装它的 profile 中替换已发布 Web Client 的根作用域 `rightbar` 展示。普通会话、输入框和左侧导航仍由 DSH 拥有。面板通过现有布局服务报告展示状态，由框架预留空间，而不是在桌面输入框上方叠加浮层。

时间线从 Session 列表派生最近的非空个人助理会话。队列展示待处理交互和运行中的会话，不授予审批。日程和记忆投影所选 Session 已加载聊天窗口中的带版本工具结果展示元数据；两者都不宣称反映实时外部状态。根作用域拥有的 observable 连接严格 Session 桥接器和根右栏，不会把一个 StoreDefinition 同时挂载到两个作用域。该 bundle 不扫描其他 Session、不另建活动数据库，也不把空闲 Agent 解释为已完成任务。连接文案表示 DSH 传输连接，而不是 Copilot 认证或日历可用性。

日历和记忆工具通过现有工具结果日志，将经过校验的结果值持久化为带版本的展示元数据。记忆写入回执不是笔记内容，写入失败会使旧预览失效，因为文件替换可能发生在 Git 失败之前。部分清单保留未列出的笔记，不能证明删除。

面板的产品文案由语言字典拥有。Nocturne token 覆盖遵循已保存的主题偏好，侧边栏导航和右栏尺寸由 DSH 拥有。Slot 注册、样式和查看状态遵循 Client 插件生命周期。可复制的日历和记忆建议不改变导航和草稿；只有明确粘贴并发送后才产生普通的已记录用户输入。Host 入口不添加工具、提示词、持久化或账号操作；[助理准入策略](2026-09-17-personal-assistant-action-admission.zh.md) 保持不变。

## Alternatives considered

**在原生停靠面板中添加 Assistant 标签页。** 这样能保留现有文档查看器，但标签页需要 Session，并且位于默认折叠的逐 Session 面板中。它无法在新会话页面提供所需的助理身份展示。

**桌面浮层或复制应用外壳。** 浮层会遮挡现有输入框，复制外壳则要求助理维护 DSH 的导航和渲染机制。根 rightbar 是现有替换点，可以保留这些功能的原有归属。

**独立活动数据库或编造任务结果。** Session 摘要已经提供真实的会话标题、更新时间和导航标识。第二份记录会重复数据，并且需要独立的完成语义。

## Consequences

助理面板会替换其 profile 中的原生文件和资源停靠展示，不宣称保留这些预览目标。其他 profile 保持各自的布局，助理的日历和记忆权限也不改变。

[组件测试](../../../../work-assistant/packages/wa-ui/tests) 覆盖展示、已记录数据失效和本地查看行为。[profile 浏览器冒烟测试](../../../../work-assistant/profile-tests/profile-smoke.mjs) 使用隔离 home 和 AgentLoop 生成的合成日历与记忆记录结果运行打包后的插件；夹具证据不是真实 Copilot 轮次。

现有[停靠](../feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)、[标签导航](2026-09-05-sidebar-tab-types-and-navigation.zh.md)、[响应式布局](2026-09-07-sidebar-responsive-tab-info.zh.md)和[语言归属](2026-08-23-locale-owned-client-ui-copy.zh.md)决策保持有效。此部署选择一种展示方式，不取代这些决策的框架和归属规则。
