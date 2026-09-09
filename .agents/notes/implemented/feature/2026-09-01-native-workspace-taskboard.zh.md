# Agent Note：原生 Workspace 任务看板模式

状态：已实现

[English](2026-09-01-native-workspace-taskboard.md) | 中文

## 问题

DSH 已有持久 Workspace、Session 与实时 Goal、Job、Subagent 状态，但没有宿主级 issue board。Session `todo_write` 是短暂三态模型清单，不能表达 Session 创建前的任务、人类审核、稳定身份、排序或持久项目规划。

独立 Taskboard 不能替换 Web shell 或 Conversation slot，也不能使用覆盖侧栏的全框 overlay。卸载 Conversation 会丢失草稿与滚动状态；用 `display:none` 隐藏会在流式滚动 observer 仍活跃时压缩几何。

## 决策

发布原生 Workspace 五列任务看板，分三层：`dsh-taskboard` 经 storage-domain 拥有带修订检查的持久记录；`dsh-api-taskboard-controller` 暴露命令与可重连 baseline/increment 流；`dsh-client-ui-taskboard` 渲染看板与 Session 关联。

Web profile 挂载 SQLite 作为第二存储后端，仅把 `taskboard` domain 路由到它；基础 profile 保持 JSON 默认。任务记录包含稳定 UUID、Workspace、显式 `backlog|todo|in_progress|in_review|done` 状态、rank、正修订号、时间戳、可选优先级与标签、可选原生 DSH Session id，以及独立可选的 Agency Copilot CLI UUID。归档与状态正交。

AppFrame 拥有 root-scoped keyed `main.surface`，选择值位于 root layout store。活跃 entry 横跨 center 与 details grid track，Sidebar 不被覆盖。Conversation 与 Details 以原尺寸保持挂载，但变为不可见、inert 且不可访问。AppFrame 向 Conversation 传入 `active:false`，让附件 document listener 与 body portal 草稿预览关闭而不是越过任务看板。

侧栏入口注册在 `sidebar.footer.action`。Session 导航先打开 Session 再关闭 Taskboard，非法 id 会保留看板。开始原生 DSH 工作时创建 Workspace Session、以 CAS 关联、把返回修订移动到 In Progress，再打开 Session。独立地，loopback-only **使用 Copilot 开始**由宿主生成并以 CAS 关联 UUID，再在不可变 Workspace path 中把固定 `agency copilot --session-id <uuid> --interactive <task>` 选项交给 Windows Terminal。持久保存的标题和描述组成初始用户提示词。打开/恢复会扫描有界 Agency JSON，避免重复启动 `in_use` 标识，并对已观察为 idle 的状态使用 `--resume=<uuid>` 而不再次提交提示词。只有确认标识不存在时，才允许携带任务内容重试新建启动。浏览器不提供 executable、argv、cwd 或环境；新建启动不接受调用方生成的 UUID。

新建任务与任务编辑也支持关联现有的本地 Copilot CLI 会话。宿主发现有界的 Agency 记录，并按任务工作区的规范路径筛选。更改后的选择会先根据当前 Agency 数据验证，再在修订 CAS 下把内容与关联一起提交。这既防止任意跨工作区关联，也防止关联失败后留下孤立任务。未更改的关联不需要发现，因此离线时仍可编辑普通任务信息。关联与执行彼此独立：它不会打开或恢复终端、重新提交指令、改变计划状态，也不会替换原生 DSH Session 关联。

任务文本经过 Windows Terminal 的分号解析器和命令行重建后仍保持为数据。adapter 复用共享 Win32 参数引用，并补偿 Terminal 添加的外层引号。过长命令行会显式失败而不是截断任务。Copilot 负责外部用户消息日志，并保留正常交互式工具审批；DSH 不把任务注入无关的原生 Session。

实时 Session、Goal、Job 与 Subagent 事实只装饰卡片，绝不改变持久状态。Agent 完成可以建议 In Review，但不能静默标记 Done。

创建任务与选择卡片打开同一个居中详情对话框。活动与已归档记录共享 controller snapshot；`archivedAt` 决定记录进入全宽归档列表而非活动列。归档是 upsert 而非删除，因此刷新可以恢复记录及其原始状态。Client 保留较新的任务修订，避免延迟回显或 baseline 回退；实际任务或 Workspace 移除则保留删除 tombstone。归档详情允许删除和现有 DSH Session 导航，但不允许编辑或 Copilot 启动。controller 丢弃已归档任务的 Agency 观察结果，包括延迟返回的检查结果。

确认删除只移除经过修订检查的 Taskboard 记录。会话关联不转移所有权：关联的 DSH Session、现有 Copilot CLI 会话和用户终端在任务删除后仍然保留。宿主将删除与 Agency 交接串行化；Client 仅在成功后应用权威移除结果，防止延迟任务回显重新创建已删除卡片。删除被拒绝时，任务保持可见，允许显式重试。

## 考虑的替代方案

**iframe 嵌入 Dashi Taskboard。** 快，但需要第二 HTTP 服务，重复项目/Session 状态，绕过 DSH slot 与主题，并保留 Codex 注入机制。

**替换 Conversation。** 会折叠所有后代并丢失草稿/视图状态。

**使用 `shell.overlay`。** 会覆盖侧栏，且该槽位用于 additive 浮动表面，不是应用导航。

**使用 chain overlay。** renderer 保留 React identity，但以 `display:none` 隐藏 fallback，流式期间会改变测量几何。layout 拥有的 keyed overlay 保持尺寸稳定。

**复用 `todo_write` 或 Agent Teams。** 它们的身份、生命周期、状态词汇与 ownership 不同；Agent Teams 仍是私有协调原型。

**打开空白 CLI 或每次恢复都重新提交。** 空白 CLI 不会开始任务。重新提交可能重复已经完成的变更，因此现有会话仍由用户控制。

**使用非交互式提示词模式。** 它在完成后退出，不能保留终端供后续工作使用。

**只在浏览器状态中保留归档卡片。** 页面刷新会丢失归档列表。同一个权威任务 feed 同时承载活动与归档记录，由展示层筛选，不创建另一份业务状态 store。

**先保存任务，再关联所选 CLI 会话。** 创建后的关联验证可能失败，导致已保存任务与提交表单不一致。一次经过验证的持久写入把两个结果保持在一起。

**随任务删除关联会话。** 现有会话可能早于任务存在，或同时关联其他任务。移除规划记录不授权停止其工作或清除其历史。

## 测试

Domain 测试覆盖排序、修订竞争、独立 DSH/Copilot 关联、Session membership、归档与重启；controller 测试覆盖 baseline-first stream、失败映射、有界无 shell Agency 解析、精确 Windows Terminal argv、先持久提交后启动顺序与陈旧 upsert tombstone；Client 测试覆盖 Agency 状态隔离、注册生命周期、入口状态、CRUD 错误、拖动/状态移动与关联 Session 导航；layout 与浏览器测试覆盖 Conversation 几何、草稿/滚动状态、portal 暂停、焦点、不执行真实 native launch 的 Copilot 控件与 Web composition。

归档 feed 测试覆盖重新打开的宿主投影、归档 upsert 和 Workspace 移除。Client 测试验证归档在陈旧更新与重连后仍然保留、延迟 Agency 观察结果被丢弃，以及计划状态与实时活动保持独立。任务看板组件测试覆盖创建后自动打开详情、双语归档筛选、只读归档详情，以及模态框内的操作反馈。

现有会话关联测试覆盖按工作区筛选的发现、切换工作区后的陈旧结果、明确的发现失败与重试、原子创建/编辑/清除、独立 DSH 关联，以及重新加载后的持久性。组件与组装 fixture 用例选择现有 CLI 会话而不启动新会话。

删除测试覆盖活动与已归档记录、删除记录之外的会话关联保留、修订冲突、移除帧、延迟回显和宿主重新打开后的状态。UI 测试覆盖双语确认、取消后保留草稿、失败与重试和重复提交防护；组装场景删除活动与已归档任务。

## 后果

通用 storage-domain CAS 只在单一 Host 进程内权威。SQLite 提供重启持久性，不提供跨进程 compare-and-set。查询扫描内存 domain table，浮点 rank 压缩延期。后续协作部署需要带 SQL 级 CAS、索引查询和持久 change feed 的专用关系 provider。

产品流程参考 Dashi Taskboard（<https://github.com/chuspeeism/dashi-taskboard>，Apache-2.0），未 vendoring 上游源代码。
