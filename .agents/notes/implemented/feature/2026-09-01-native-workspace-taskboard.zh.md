# Agent Note: 原生 Workspace 任务看板模式

Status: implemented

[English](2026-09-01-native-workspace-taskboard.md) | 中文

## 问题

DSH 已有持久 Workspace、Session 与实时 Goal、Job、Subagent 状态，但没有宿主级 issue board。Session `todo_write` 是短暂三态模型清单，不能表达 Session 创建前的任务、人类审核、稳定身份、排序或持久项目规划。

独立 Taskboard 不能替换 Web shell 或 Conversation slot，也不能使用覆盖侧栏的全框 overlay。卸载 Conversation 会丢失草稿与滚动状态；用 `display:none` 隐藏会在流式滚动 observer 仍活跃时压缩几何。

## 决策

发布原生 Workspace 五列任务看板，分三层：`dsh-taskboard` 经 storage-domain 拥有带修订检查的持久记录；`dsh-api-taskboard-controller` 暴露命令与可重连 baseline/increment 流；`dsh-client-ui-taskboard` 渲染看板。[执行与唯一对话决策](2026-09-09-taskboard-execution-and-conversations.zh.md) 取代本说明中的独立关联与终端拥有启动策略；本说明仍负责展示和计划的设计理由。

Web profile 挂载 SQLite 作为第二存储后端，仅把 `taskboard` domain 路由到它；基础 profile 保持 JSON 默认。计划记录包含稳定 UUID、Workspace、显式 `backlog|todo|in_progress|in_review|done` 状态、rank、正修订号、时间戳、可选优先级与标签。归档与状态正交。

AppFrame 拥有 root-scoped keyed `main.surface`，选择值位于 root layout store。活跃 entry 横跨 center 与 details grid track，Sidebar 不被覆盖。Conversation 与 Details 以原尺寸保持挂载，但变为不可见、inert 且不可访问。AppFrame 向 Conversation 传入 `active:false`，让附件 document listener 与 body portal 草稿预览关闭而不是越过任务看板。

侧栏入口注册在 `sidebar.footer.action`。Session 导航先打开 Session 再关闭 Taskboard，非法 id 会保留看板。Run 等待宿主确认调度后才导航。未保存的执行输入会阻止调度，而不是静默发送旧内容；打开关联对话绝不重新提交指令。

Session 顶部导航从当前 DSH 任务关联推导目标，包括归档任务，不使用历史或未解决的关联。root-scoped 子控件与 Taskboard 共享一次性选择 store；Session-scoped 顶部组件不创建各 Session 独立的导航 store。消费请求可防止普通侧栏导航重新打开陈旧详情。多个当前关联需要用户明确选择。

新建任务与任务编辑支持关联现有对话。宿主在提交更改后的选择前验证 Workspace 归属。创建可同时保存内容和经过验证的关联，防止关联验证失败后留下孤立任务。普通计划信息编辑不需要 provider 发现。

原生终端导航使用宿主推导的标识和已注册 Workspace 路径。浏览器不提供 executable、argv、cwd 或环境。adapter 在经过 Windows Terminal 分号解析器和命令行重建时，保留固定恢复参数与共享 Win32 引用规则。

**已被取代的状态策略：** 实时 Session、Goal、Job 与 Subagent 事实只装饰卡片，绝不改变持久状态。Agent 完成可以建议 In Review，但不能静默标记 Done。[执行驱动的列状态](2026-09-09-taskboard-execution-driven-columns.zh.md) 对关联的 Taskboard 执行取代此规则；无关实时事实仍只用于装饰。

新建任务在保存或保存并关闭成功前保留本地草稿。保存后继续使用与选择卡片相同的居中详情对话框；保存并关闭则返回看板。取消丢弃未保存的创建草稿，不执行写入。归档和删除仅适用于已保存任务。关闭等待持久化完成，使被拒绝的保存及其草稿保持可见；延迟完成的保存不能关闭另一项已选任务。

活动与已归档记录共享 controller snapshot；`archivedAt` 决定记录进入全宽归档列表而非活动列。归档是 upsert 而非删除，因此刷新可以恢复记录及其原始状态。Client 保留较新的任务修订，避免延迟回显或 baseline 回退；实际任务或 Workspace 移除则保留删除 tombstone。归档详情允许恢复、删除和对话导航，但不允许执行或内容编辑。controller 丢弃已归档任务的 Agency 观察结果，包括延迟返回的检查结果。

确认删除只移除经过修订检查的 Taskboard 记录。会话关联不转移所有权：关联的 DSH Session、现有 Copilot CLI 会话和用户终端在任务删除后仍然保留。宿主将删除与 Agency 交接串行化；Client 仅在成功后应用权威移除结果，防止延迟任务回显重新创建已删除卡片。删除被拒绝时，任务保持可见，允许显式重试。

## 考虑的替代方案

**iframe 嵌入 Dashi Taskboard。** 快，但需要第二 HTTP 服务，重复项目/Session 状态，绕过 DSH slot 与主题，并保留 Codex 注入机制。

**替换 Conversation。** 会折叠所有后代并丢失草稿/视图状态。

**使用 `shell.overlay`。** 会覆盖侧栏，且该槽位用于 additive 浮动表面，不是应用导航。

**使用 chain overlay。** renderer 保留 React identity，但以 `display:none` 隐藏 fallback，流式期间会改变测量几何。layout 拥有的 keyed overlay 保持尺寸稳定。

**复用 `todo_write` 或 Agent Teams。** 它们的身份、生命周期、状态词汇与 ownership 不同；Agent Teams 仍是私有协调原型。

**打开空白 CLI 或每次恢复都重新提交。** 空白 CLI 不会开始任务。重新提交可能重复已经完成的变更，因此现有会话仍由用户控制。

**把原生 Session 创建当作任务执行。** 创建只提供可寻址的 Session。prompt API 负责输入接纳、用户消息记录与 Agent 执行；Taskboard 使用该 API，而不是复制循环或根据空 Session 推断成功。

**只在浏览器状态中保留归档卡片。** 页面刷新会丢失归档列表。同一个权威任务 feed 同时承载活动与归档记录，由展示层筛选，不创建另一份业务状态 store。

**持久化 Session 到任务的反向索引。** 当前任务关联已能确定目标。第二份持久索引可能在断开、重新关联或删除后产生分歧，而纯展示导航不需要它。

**先保存任务，再关联所选 CLI 会话。** 创建后的关联验证可能失败，导致已保存任务与提交表单不一致。一次经过验证的持久写入把两个结果保持在一起。

**随任务删除关联会话。** 现有会话可能早于任务存在，或同时关联其他任务。移除规划记录不授权停止其工作或清除其历史。

## 测试

计划测试覆盖排序、修订竞争、Workspace 归属、归档和重启。controller 与 Client 测试保留 baseline-first stream、失败可见性、延迟响应防护、注册生命周期、拖动/状态移动和对话导航。布局与浏览器测试覆盖 Conversation 几何、草稿、滚动状态、portal 暂停、焦点、不启动真实终端的原生打开控件，以及 Web composition。

归档 feed 测试覆盖重新打开的宿主投影、归档 upsert 和 Workspace 移除。Client 测试验证归档在陈旧更新与重连后仍然保留、延迟 Agency 观察结果被丢弃，以及计划状态与实时活动保持独立。任务看板组件测试覆盖未保存草稿的取消、两种保存选择、等待中与失败的保存、任务移除后延迟完成的保存、双语归档筛选、只读归档详情，以及模态框内的操作反馈。

现有对话测试覆盖按 Workspace 筛选的发现、Workspace 更改后的陈旧选择、可见发现失败、带关联的原子创建、明确断开，以及重新加载后的持久性。组件与组装用例选择对话而不开始工作。Session 顶部导航覆盖当前关联、归档详情、共享 Session 的任务选择、任务删除提示、已消费请求，以及执行历史保持不变。

删除测试覆盖活动与已归档记录、删除记录之外的会话关联保留、修订冲突、移除帧、延迟回显和宿主重新打开后的状态。UI 测试覆盖双语确认、取消后保留草稿、失败与重试和重复提交防护；组装场景删除活动与已归档任务。

执行与恢复覆盖遵循[执行决策](2026-09-09-taskboard-execution-and-conversations.zh.md#testing)。[Taskboard 启动场景](../../../../snapshots/web/taskboard-start-work/)保留组装 Web 路径和借用的真实响应流，支持无密钥回放。

## 后果

通用 storage-domain CAS 只在单一 Host 进程内权威。SQLite 提供重启持久性，不提供跨进程 compare-and-set。查询扫描内存 domain table，浮点 rank 压缩延期。后续协作部署需要带 SQL 级 CAS、索引查询和持久 change feed 的专用关系 provider。

产品流程参考 Dashi Taskboard（<https://github.com/chuspeeism/dashi-taskboard>，Apache-2.0），未 vendoring 上游源代码。
