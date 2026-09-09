# 任务看板

[English](taskboard.md) | 中文

Taskboard 是 DSH 的持久化 Workspace issue board。它把人类规划状态与实时 Session 执行分离：任务可以先于 Session 存在，在积压、待办、进行中、审核中和已完成之间移动，并可选择关联一个 Session。运行中的 Session、Job、Subagent 和被阻塞 Goal 只装饰卡片，绝不自动完成任务。

源码：[`packages/workspace/taskboard/src/types.ts`](../../packages/workspace/taskboard/src/types.ts)

## 持久记录

每个任务使用稳定 UUID key、全局人类可读 ordinal、Workspace id、按 Workspace 与状态限定的数值 rank、正修订号、时间戳、标题、描述、标签、可选优先级、可选原生 DSH Session id、独立可选的 Agency Copilot CLI 会话 UUID 与可选归档时间。归档与五个可见状态正交。`taskboard` storage domain 每个任务一个 record，Web profile 把该 domain 路由到 SQLite storage backend。新增 Copilot 可选字段让现有 version-1 记录保持可读。

每次变更进入同一个 Taskboard 服务队列。服务在队列槽位检查精确修订号；写入时用持久 Zod schema 验证完整 candidate，删除时移除现有行。操作提交后，observer 才收到 `domain/changed`。删除适用于活动或已归档记录，关联 Session 与终端不受影响。该 compare-and-set 保证是进程内的；storage-domain SQLite backend 不提供跨进程条件写入。

## 浏览器传输与 UI

[Taskboard Controller](../../packages/api/taskboard-controller/README.zh.md) 暴露带修订检查的 Remote 命令与可重连 stream。每个 generation 先注册 follower、发送完整 baseline，再发送有序 task upsert 与带修订号 removal。归档记录以只读行保留在 snapshot 中。Client model 保留较新的任务修订与实际删除 tombstone，抵御延迟的 unary echo 和 stream frame。

[ui-taskboard](../../packages/client/ui-taskboard/README.zh.md) 占据 layout 拥有的 keyed `main.surface`，并贡献 additive 侧栏 footer 行。AppFrame 覆盖 center 与 details，同时保持其几何挂载；Conversation 收到 `active:false`，document 级附件与瞬时 portal 行为会退出。显式 Session 导航先打开，再关闭 Taskboard。

新建任务与任务编辑可以关联任务工作区中现有的 Copilot CLI 会话。宿主根据本地 Agency 数据验证更改后的选择，再把任务内容与关联一起提交。关联不会启动执行，也不会替换原生 DSH Session 关联；[UI 指南](../../packages/client/ui-taskboard/README.zh.md#associate-an-existing-copilot-cli-session)介绍选择、刷新与失败恢复。

在 loopback Web 页面上，**使用 Copilot 开始**让宿主生成并持久保存新的外部 UUID，再在任务 Workspace 中打开交互式 Copilot 终端并提交持久保存的标题和描述。**打开/恢复 Copilot**观察 Agency 的有界本地会话列表，绝不重复启动 `in_use` 会话，并在恢复已观察为 idle 的标识时不再次提交任务。[controller](../../packages/api/taskboard-controller/README.zh.md) 负责提示词提交和启动限制。这是终端交接，不是 transcript 导入：原生 DSH Session 状态与 Copilot 终端标识可以共存，二者都不会自动改变 Taskboard 规划状态。

## 运行限制

当前查询扫描内存 domain table。数值 fractional rank 反复二分同一间隙后最终可能耗尽。多进程协作、索引分页、评论、附件、transcript 导入与 Host-owned 原生 DSH start-work saga 延期处理。Windows Terminal 接受请求是尽力而为；后续状态刷新才能确定 Agency 是否观察到 Copilot 进程。

设计记录：[原生 Workspace Taskboard Agent Note](../../.agents/notes/implemented/feature/2026-09-01-native-workspace-taskboard.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskboard--taskboardservice"></a>

### `ctx.taskboard` — `TaskboardService`

Durable Taskboard command and query service.

```ts cordis-catalog
/**
 * List tasks in deterministic board order.
 * @param workspaceId - Optional Workspace filter.
 * @param includeArchived - Include archived tasks when true.
 * @returns detached current tasks.
 */
list(workspaceId?: WorkspaceId, includeArchived: boolean = false): TaskboardTask[]

/**
 * Read one task by identity.
 * @param taskId - Stable task identity.
 * @returns detached task or undefined when absent.
 */
get(taskId: TaskId): TaskboardTask | undefined

/**
 * Create a durable task and optional Host-validated Agency link in one write.
 * @param input - Initial fields; the caller must validate an Agency identity against its Workspace.
 * @param signal - Cancellation checked at the serialized write slot, before durability begins.
 * @returns the committed task.
 */
create(input: TaskboardCreateInput, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Update content and independent Session links in one revision-checked write.
 * @param input - Mutable fields; the caller must validate a newly selected Agency identity against the task Workspace.
 * @param signal - Cancellation checked at the serialized write slot, before durability begins.
 * @returns the committed task, or the unchanged task for a material no-op.
 */
update(input: TaskboardUpdateInput, signal?: AbortSignal): Promise<TaskboardTask>

/**
 * Set or clear one Host-validated Agency Copilot terminal identity with revision CAS.
 * @param input - Task, exact revision, and the validated identity or null to clear.
 * @returns the committed task, or the unchanged task for a material no-op.
 */
setAgencyCopilotSession(input: TaskboardSetAgencyCopilotSessionInput): Promise<TaskboardTask>

/**
 * Move a task into a column and optionally before another task.
 * @param input - Exact revision and destination position.
 * @returns the committed task, or unchanged current task for a same-position move.
 */
move(input: TaskboardMoveInput): Promise<TaskboardTask>

/**
 * Archive one task with revision CAS.
 * @param taskId - Task identity.
 * @param expectedRevision - Exact current revision.
 * @returns the committed archived task; repeated exact-revision archive is unchanged.
 */
archive(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask>

/**
 * Permanently delete an active or archived task without changing its Workspace, Sessions, or terminals.
 * @param taskId - Task identity; a missing task rejects.
 * @param expectedRevision - Exact current revision, checked in the serialized mutation slot.
 * @param signal - Cancellation checked before the durable deletion begins; an in-flight deletion settles normally.
 * @returns a durable removal receipt with Number.MAX_SAFE_INTEGER as the tombstone revision.
 */
delete(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<TaskboardDeleteValue>
```

Types: [WorkspaceId](workspace.zh.md)

Source: [`packages/workspace/taskboard/src/index.ts`](../../packages/workspace/taskboard/src/index.ts)

<a id="ctxtaskboardcontroller--taskboardcontroller"></a>

### `ctx.taskboardController` — `TaskboardController`

Host service backing the generated `ctx.remote.taskboard` namespace. Business failures throw RemoteError with `taskboard/*` codes and typed details.

```ts cordis-catalog
/** Return active and archived tasks belonging to registered Workspaces.
 * @param request - Optional Workspace filter.
 * @returns matching tasks; archived rows retain their status and archivedAt.
 */
@Remote('list') list(request: TaskboardListRequest): Promise<TaskboardListValue>

/** Create content and an optional existing Agency link in one durable write.
 * @param request - Initial task fields; selected Agency identities must be discoverable in the Workspace.
 * @param signal - Caller cancellation before the durable write begins.
 * @returns committed task; selection never launches Copilot or changes planning status.
 */
@Remote('create') async create( request: TaskboardCreateRequest, signal?: AbortSignal, ): Promise<TaskboardTaskValue>

/** Update task content or linkage with revision CAS.
 * @param request - Exact revision and field patch; only changed Agency identities require discovery.
 * @param signal - Caller cancellation before the durable write begins.
 * @returns content and links committed together without launching Copilot or changing planning status.
 */
@Remote('update') async update( request: TaskboardUpdateRequest, signal?: AbortSignal, ): Promise<TaskboardTaskValue>

/** Move a task with revision CAS.
 * @param request - Exact revision and destination.
 * @returns committed task.
 */
@Remote('move') async move(request: TaskboardMoveRequest): Promise<TaskboardTaskValue>

/** Archive a task with revision CAS.
 * @param request - Exact revision archive request.
 * @returns committed archived task.
 */
@Remote('archive') async archive(request: TaskboardArchiveRequest): Promise<TaskboardTaskValue>

/**
 * Delete an active or archived task, serialized with Agency operations, without changing linked Sessions or terminals.
 * @param request - Task identity and exact current revision; stale or missing tasks reject without retry.
 * @param signal - Cancellation before durable deletion begins; an in-flight deletion settles normally.
 * @returns the committed task removal and its authoritative tombstone revision.
 */
@Remote('delete') async delete(request: TaskboardDeleteRequest, signal?: AbortSignal): Promise<TaskboardDeleteValue>

/**
 * Report whether this Host deployment permits native Agency Copilot launch.
 * @returns true only for a loopback-bound Web server outside SSH.
 */
@Remote('agencyCopilotCapability') agencyCopilotCapability(): TaskboardAgencyCopilotCapabilityValue

/**
 * Discover existing local Copilot sessions matching a registered Workspace's canonical folder.
 * @param request - Registered Workspace whose sessions are selectable.
 * @param signal - Caller cancellation for discovery and folder resolution.
 * @returns safe session metadata and bounded-scan truncation; discovery failures reject explicitly.
 */
@Remote('listAgencyCopilotSessions') async listAgencyCopilotSessions( request: TaskboardListAgencyCopilotSessionsRequest, signal: AbortSignal, ): Promise<TaskboardListAgencyCopilotSessionsValue>

/**
 * Start a fresh local Agency Copilot terminal and persist its generated identity first.
 * @param request - Task identity and exact current revision.
 * @param signal - Caller cancellation before commit or terminal handoff acceptance.
 * @returns the committed linked task and accepted-launch receipt.
 */
@Remote('startAgencyCopilot') async startAgencyCopilot( request: TaskboardStartAgencyCopilotRequest, signal: AbortSignal, ): Promise<TaskboardStartAgencyCopilotValue>

/**
 * Clear one task's Agency Copilot identity without touching its terminal process.
 * @param request - Task identity and exact current revision.
 * @returns the committed task without an Agency Copilot link.
 */
@Remote('clearAgencyCopilot') async clearAgencyCopilot(request: TaskboardClearAgencyCopilotRequest): Promise<TaskboardTaskValue>

/**
 * Open a linked Copilot identity: report active, resume idle, or retry an identity not yet materialized.
 * @param request - Task whose durable Copilot identity is addressed.
 * @param signal - Caller cancellation for status discovery and terminal handoff.
 * @returns whether Copilot was already running or a launch handoff was accepted.
 */
@Remote('openAgencyCopilot') async openAgencyCopilot( request: TaskboardOpenAgencyCopilotRequest, signal: AbortSignal, ): Promise<TaskboardOpenAgencyCopilotValue>

/**
 * Inspect current Agency status for linked tasks without launching or mutating them.
 * @param request - Bounded task identities whose linked Copilot status is requested.
 * @param signal - Caller cancellation for bounded Agency status discovery.
 * @returns transient observations for the currently linked requested tasks.
 */
@Remote('inspectAgencyCopilot') async inspectAgencyCopilot( request: TaskboardInspectAgencyCopilotRequest, signal: AbortSignal, ): Promise<TaskboardInspectAgencyCopilotValue>

/** Stream active and archived tasks followed by ordered upserts and removals.
 * @param signal - Generation cancellation.
 * @returns a registered-Workspace baseline followed by task changes, including archive upserts.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<TaskboardFollowFrame>
```

Source: [`packages/api/taskboard-controller/src/index.ts`](../../packages/api/taskboard-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
