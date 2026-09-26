# 任务看板

[English](taskboard.md) | 中文

Taskboard 保存持久化的 Workspace 任务定义及其执行记录。每个任务最多有一个当前对话：DSH Session 或 Copilot CLI 会话。重复运行继续使用该对话。新任务从 Todo 开始；执行状态和用户处理需求会更新其所在列。

源码：[`packages/workspace/taskboard/src/types.ts`](../../packages/workspace/taskboard/src/types.ts)

## 持久记录

`TaskboardTask` 包含计划字段、已保存的运行提示词、明确执行选项、可选计划与冻结交接，以及有界执行历史。派生字段 `allowedManualStatuses` 向 Client 提供当前状态之外的全部状态。`TaskConnection` 区分 DSH 与 Copilot 标识。更换当前标识前必须明确断开关联。保留的待选择关联会阻止执行，直到用户选择其中一个。

`TaskExecution` 为一次已接受请求保存提示词、设置、交接、Workspace 和对话快照。其 pending、running、succeeded、failed 或 cancelled 结果与任务所在列分别存储。准入会将任务移到 In Progress；等待用户输入会移到 In Review，但不结算执行；恢复工作后回到 In Progress。成功结算移到 Done；失败或取消移到 In Review。provider 回执支持不重发提示词的恢复。当前关联更改后，历史记录仍保留各自的对话标识。

[domain 包](../../packages/workspace/taskboard/README.zh.md) 负责记录验证、有界保留、请求去重、修订检查和计划执行准入。只有持久提交后才发布变更。归档独立于计划状态；恢复会禁用调度。删除任务和断开关联都不会删除对话。

## 浏览器传输与 UI

[Taskboard Controller](../../packages/api/taskboard-controller/README.zh.md) 负责宿主执行、cron 计算、完成监控和可重连 Remote stream。baseline 包含活动与已归档任务，以及设置、调度器和电源观察结果。Client 保留较新任务修订与删除 tombstone，抵御延迟响应。

[ui-taskboard](../../packages/client/ui-taskboard/README.zh.md) 占据 layout 拥有的 keyed `main.surface`，并贡献 additive 侧栏 footer 行。AppFrame 覆盖 center 与 details，同时保持其几何挂载；Conversation 收到 `active:false`，document 级附件与瞬时 portal 行为会退出。显式 Session 导航先打开，再关闭 Taskboard。

[UI 指南](../../packages/client/ui-taskboard/README.zh.md) 介绍现有对话选择、Run 与 Run Again、执行历史、可编辑副本、归档、交接和设置。对话导航与执行不同，绝不提交已保存的提示词。

浏览器断开后，宿主仍负责执行。内核所有权防止配置相同的 runner 竞争；provider 专属证据决定执行结果。调度跳过错过或忙碌时点，而非积累重试。controller 参考文档负责说明权限、恢复、兼容性和空闲睡眠限制。

## 运行限制

查询扫描内存 domain table，反复二分的 fractional-rank 间隙可能耗尽数值精度。本系统不提供多进程协作、索引分页、评论、附件或 Copilot transcript 导入。SQLite 持久性不会将 domain 的进程内修订检查变成 SQL 层 compare-and-set。

设计记录：[原生 Workspace Taskboard](../../.agents/notes/implemented/feature/2026-09-01-native-workspace-taskboard.zh.md)、[执行驱动的列状态](../../.agents/notes/implemented/feature/2026-09-09-taskboard-execution-driven-columns.zh.md)和[手动状态控制](../../.agents/notes/implemented/feature/2026-09-25-taskboard-manual-status-control.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskboard--taskboardservice"></a>

### `ctx.taskboard` — `TaskboardService`

Durable commands; external provider dispatch belongs to the Host runner.

```ts cordis-catalog
/**
 * List in deterministic board order.
 * @param workspaceId - Optional Workspace filter.
 * @param includeArchived - Include archived records.
 * @returns deeply detached current tasks.
 */
list(workspaceId?: WorkspaceId, includeArchived: boolean = false): TaskboardTask[]

/**
 * Read one task.
 * @param taskId - Stable identity.
 * @returns detached task or undefined when absent.
 */
get(taskId: TaskId): TaskboardTask | undefined

/**
 * Find a committed retry before provider resolution, even after its displayed history is pruned.
 * @param input - Original manual request identity, expected revision, and initiator; changed caller fields reject.
 * @returns the original execution identity and current task, or undefined for an absent or expired receipt.
 */
getRunRequest(input: TaskboardRunRequestLookupInput): TaskboardBeginExecutionValue | undefined

/**
 * Create a Todo task unless a column is explicit; an existing conversation commits in the same write.
 * @param input - Initial choices; the Host validates Copilot membership before selecting a connection.
 * @param signal - Cancellation checked before the durable write begins.
 * @returns committed task.
 */
create(input: TaskboardCreateInput, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Apply planning changes with CAS; open attempts forbid execution-input changes.
 * @param input - Exact revision and patch; null clears handover or schedule.
 * @param signal - Cancellation checked before durability begins.
 * @returns committed task, unchanged for a material no-op.
 */
update(input: TaskboardUpdateInput, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Select the exclusive connection or one preserved legacy choice.
 * @param input - Exact revision and identity; caller validates Copilot Workspace membership.
 * @param signal - Cancellation checked before durability begins.
 * @returns committed connected task.
 */
connect(input: TaskboardConnectInput, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Clear connection choices without touching provider conversations.
 * @param taskId - Task identity.
 * @param expectedRevision - Exact planning revision.
 * @param signal - Cancellation checked before durability begins.
 * @returns committed disconnected task.
 */
disconnect(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Record explicit approval of current permission and handover choices.
 * @param taskId - Task identity.
 * @param expectedRevision - Exact revision displayed to the approving user.
 * @returns committed confirmation; open attempts reject.
 */
confirmPermissions(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask>

/**
 * Move or reorder an active task with CAS.
 * @param input - Exact revision and destination.
 * @returns committed task or unchanged same-position task.
 */
move(input: TaskboardMoveInput): Promise<TaskboardTask>

/**
 * Archive without altering planning status or provider conversations; disable scheduling.
 * @param taskId - Task identity.
 * @param expectedRevision - Exact revision.
 * @returns committed task or unchanged archived record.
 */
archive(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask>

/**
 * Restore archived planning state without enabling its schedule.
 * @param taskId - Task identity.
 * @param expectedRevision - Exact revision.
 * @returns restored task or unchanged active record.
 */
restore(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask>

/**
 * Copy planning and execution choices with fresh identity, no history, and a disabled schedule.
 * @param input - Source revision and optional replacement title.
 * @param signal - Cancellation checked before durability begins.
 * @returns new task; the original is never archived or modified.
 */
duplicate(input: TaskboardDuplicateInput, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Permanently delete a task without touching Workspace or provider conversations.
 * @param taskId - Task identity.
 * @param expectedRevision - Exact revision checked before deletion.
 * @param signal - Cancellation checked before durability begins; submitted writes settle normally.
 * @returns permanent removal tombstone; an open attempt rejects.
 */
delete(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<TaskboardDeleteValue>

/**
 * Persist pending admission, immutable inputs, and In Progress placement before external dispatch.
 * @param input - Stable retry id, execution pins, and manual CAS or exact due occurrence.
 * @param signal - Cancellation checked before durability begins.
 * @returns original execution id on matching replay, even with a stale task revision.
 */
beginExecution(input: TaskboardBeginExecutionInput, signal?: AbortSignal): Promise<TaskboardBeginExecutionValue>

/**
 * Persist an open attempt's connection, monotonic receipt, or diagnostic without changing its status.
 * @param input - Exact attempt and provider identity; the Host validates Copilot membership.
 * @returns committed task; already committed identities cannot be replaced.
 */
attachExecution(input: TaskboardAttachExecutionInput): Promise<TaskboardTask>

/**
 * Observe running work; waiting for input places it in In Review, otherwise In Progress.
 * @param input - Exact attempt, optional input-wait flag, and receipt enrichment; the start timestamp is immutable.
 * @returns committed task, unchanged for a repeated observation; terminal attempts reject.
 */
advanceExecution(input: TaskboardAdvanceExecutionInput): Promise<TaskboardTask>

/**
 * Persist an open diagnostic without provider lookup or a pending/running transition.
 * @param input - Exact attempt and diagnostic, or null to clear it.
 * @returns committed task; terminal attempts reject and unchanged diagnostics are no-ops.
 */
recordExecutionError(input: TaskboardRecordExecutionErrorInput): Promise<TaskboardTask>

/**
 * Settle one exact attempt into Done on success or In Review on failure/cancellation.
 * @param input - Terminal outcome; runtime settlement does not use planning CAS.
 * @returns committed task with the terminal diagnostic; matching repeats preserve subsequent human column changes.
 */
settleExecution(input: TaskboardSettleExecutionInput): Promise<TaskboardTask>

/**
 * Advance a due busy/missed occurrence without opening an attempt.
 * @param input - Exact current occurrence and Host-calculated successor.
 * @returns committed task; stale or not-yet-due occurrences reject.
 */
rollForwardSchedule(input: TaskboardRollForwardScheduleInput): Promise<TaskboardTask>
```

Types: [WorkspaceId](workspace.zh.md)

Source: [`packages/workspace/taskboard/src/index.ts`](../../packages/workspace/taskboard/src/index.ts)

<a id="ctxtaskboardcontroller--taskboardcontroller"></a>

### `ctx.taskboardController` — `TaskboardController`

Host owner of revision-checked planning and execution commands.

```ts cordis-catalog
/**
 * Read active and archived tasks in registered Workspaces.
 * @param request - Optional Workspace filter.
 * @returns the current task and Host runtime baseline.
 */
@Remote('list') list(request: TaskboardListRequest): Promise<TaskboardListValue>

/**
 * Create a task and an optional validated existing connection atomically.
 * @param request - Saved task inputs; association never submits a prompt.
 * @param signal - Cancellation before the durable write.
 * @returns the committed task.
 */
@Remote('create') async create(request: TaskboardCreateRequest, signal?: AbortSignal): Promise<TaskboardTaskValue>

/**
 * Save planning and execution inputs without changing the current connection.
 * @param request - Exact revision and explicit field patch.
 * @param signal - Cancellation before the durable write.
 * @returns the committed task; open-attempt restrictions are enforced by the domain.
 */
@Remote('update') async update(request: TaskboardUpdateRequest, signal?: AbortSignal): Promise<TaskboardTaskValue>

/**
 * Select one existing conversation, including resolution of preserved legacy choices.
 * @param request - Exact task revision and selected connection.
 * @param signal - Cancellation of discovery or pre-commit work.
 * @returns the committed task; neither provider is activated by association.
 */
@Remote('connect') async connect(request: TaskboardConnectRequest, signal: AbortSignal): Promise<TaskboardTaskValue>

/**
 * Remove the task connection without stopping or deleting the conversation.
 * @param request - Exact task revision.
 * @param signal - Cancellation before durability.
 * @returns the committed task; open attempts prevent disconnect.
 */
@Remote('disconnect') async disconnect(request: TaskboardDisconnectRequest, signal?: AbortSignal): Promise<TaskboardTaskValue>

/**
 * Admit one request and await prompt acknowledgement, not agent completion.
 * @param request - Exact task revision and stable manual retry identity.
 * @param signal - Caller cancellation only before durable admission.
 * @returns the durable execution identity and current task.
 */
@Remote('run') async run(request: TaskboardRunRequest, signal: AbortSignal): Promise<TaskboardRunValue>

/**
 * Move a task between manual planning columns.
 * @param request - Exact task revision and destination.
 * @returns the committed task.
 */
@Remote('move') async move(request: TaskboardMoveRequest): Promise<TaskboardTaskValue>

/**
 * Archive a task and disable its schedule without changing its conversation.
 * @param request - Exact task revision.
 * @returns the committed archived task.
 */
@Remote('archive') async archive(request: TaskboardArchiveRequest): Promise<TaskboardTaskValue>

/**
 * Restore a task with its history retained and schedule disabled.
 * @param request - Exact archived revision.
 * @returns the restored task.
 */
@Remote('restore') async restore(request: TaskboardRestoreRequest): Promise<TaskboardTaskValue>

/**
 * Copy saved task inputs without copying its connection, history, or permission confirmation.
 * @param request - Exact source revision and optional edited title.
 * @param signal - Cancellation before creation.
 * @returns the new task; the source is not archived implicitly.
 */
@Remote('duplicate') async duplicate(request: TaskboardDuplicateRequest, signal?: AbortSignal): Promise<TaskboardTaskValue>

/**
 * Confirm the task's current explicit permission and handover choices.
 * @param request - Exact revision being confirmed.
 * @returns the committed confirmation; later relevant edits invalidate it.
 */
@Remote('confirmPermissions') async confirmPermissions(request: TaskboardConfirmPermissionsRequest): Promise<TaskboardTaskValue>

/**
 * Delete a task without deleting its provider conversations.
 * @param request - Exact task revision.
 * @param signal - Cancellation before the durable deletion.
 * @returns the committed removal tombstone; open attempts prevent deletion.
 */
@Remote('delete') async delete(request: TaskboardDeleteRequest, signal?: AbortSignal): Promise<TaskboardDeleteValue>

/**
 * List the current execution choices without activating a conversation.
 * @returns preset, permission, and model choices, with explicit catalog failures.
 */
@Remote('executionOptions') async executionOptions(): Promise<TaskboardExecutionOptionsValue>

/**
 * Persist Taskboard user switches through the ordinary settings service.
 * @param request - Explicit changes to enabled, announcement, or idle-sleep protection.
 * @returns the applied Host runtime observation.
 */
@Remote('updateSettings') updateSettings(request: TaskboardUpdateSettingsRequest): Promise<TaskboardRuntimeState>

/**
 * Report deployment availability for native Copilot execution and navigation.
 * @returns the local execution and terminal-handoff capability.
 */
@Remote('agencyCopilotCapability') agencyCopilotCapability(): TaskboardAgencyCopilotCapabilityValue

/**
 * Discover local Copilot conversations without activating them.
 * @param request - Workspace whose canonical folder must match.
 * @param signal - Cancellation of bounded discovery.
 * @returns matching metadata and whether discovery was truncated.
 */
@Remote('listAgencyCopilotSessions') async listAgencyCopilotSessions( request: TaskboardListAgencyCopilotSessionsRequest, signal: AbortSignal, ): Promise<TaskboardListAgencyCopilotSessionsValue>

/**
 * Open a current or historical Copilot conversation without submitting a prompt.
 * @param request - Task and optional retained execution selecting the stored identity.
 * @param signal - Caller cancellation of the handoff wait.
 * @returns an existing-running or accepted-resume outcome; missing history is never recreated.
 */
@Remote('openAgencyCopilot') async openAgencyCopilot( request: TaskboardOpenAgencyCopilotRequest, signal: AbortSignal, ): Promise<TaskboardOpenAgencyCopilotValue>

/**
 * Inspect current Copilot connections without changing task planning or execution outcomes.
 * @param request - Bounded task identities.
 * @param signal - Cancellation of discovery.
 * @returns transient observations tied to their exact connection identities.
 */
@Remote('inspectAgencyCopilot') async inspectAgencyCopilot( request: TaskboardInspectAgencyCopilotRequest, signal: AbortSignal, ): Promise<TaskboardInspectAgencyCopilotValue>

/**
 * Follow tasks and runtime observations from a complete reconnect baseline.
 * @param signal - Follow generation cancellation.
 * @returns ordered task, removal, and Host runtime frames.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<TaskboardFollowFrame>
```

Source: [`packages/api/taskboard-controller/src/index.ts`](../../packages/api/taskboard-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
