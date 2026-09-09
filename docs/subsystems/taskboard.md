# Taskboard

English | [中文](taskboard.zh.md)

The Taskboard is DSH's durable Workspace issue board. It separates human planning status from live Session execution: tasks can exist before a Session, move through Backlog, Todo, In Progress, In Review, and Done, and optionally link to one Session. Running Sessions, Jobs, Subagents, and blocked Goals decorate cards but never complete them automatically.

Source: [`packages/workspace/taskboard/src/types.ts`](../../packages/workspace/taskboard/src/types.ts)

## Durable records

Each task uses a stable UUID key, global human-facing ordinal, Workspace id, numeric rank scoped to its Workspace and status, positive revision, timestamps, title, description, labels, optional priority, optional native DSH Session id, an independent optional Agency Copilot CLI session UUID, and optional archive instant. Archive remains orthogonal to the five visible statuses. The `taskboard` storage domain uses one record per task and the Web profile routes that domain to the SQLite storage backend. The additive Copilot field keeps existing version-1 records readable.

Every mutation enters one Taskboard service queue. The exact revision is checked at that queue slot; writes validate the complete candidate with the durable Zod schema, while deletion removes the existing row. Observers receive `domain/changed` only after the operation commits. Deletion applies to active or archived records and leaves linked Sessions and terminals untouched. This compare-and-set guarantee is process-local; storage-domain's SQLite backend does not provide cross-process conditional writes.

## Browser transport and UI

[Taskboard Controller](../../packages/api/taskboard-controller/README.md) exposes revision-checked Remote commands and a reconnect-safe stream. Each generation registers its follower, emits a complete baseline, then emits ordered task upserts and revisioned removals. Archives remain in the snapshot as read-only rows. The Client model retains newer task revisions and actual-deletion tombstones against delayed unary echoes and stream frames.

[ui-taskboard](../../packages/client/ui-taskboard/README.md) occupies the layout-owned keyed `main.surface` and contributes an additive sidebar footer row. AppFrame overlays center and details while keeping their geometry mounted; Conversation receives `active:false` so document-level attachment and transient portal behavior withdraws. Explicit Session navigation opens first and closes Taskboard second.

New Task and task editing can associate an existing Copilot CLI session from the task Workspace. The Host validates a changed selection against local Agency data before committing the task content and link together. Association does not start execution or replace the native DSH Session link; the [UI guide](../../packages/client/ui-taskboard/README.md#associate-an-existing-copilot-cli-session) describes selection, refresh, and failure recovery.

On a loopback Web page, **Start with Copilot** asks the Host to generate and persist a fresh external UUID, then opens an interactive Copilot terminal at the task Workspace and submits the persisted title and description. **Open/Resume Copilot** observes Agency's bounded local session list, never duplicates an `in_use` session, and resumes an observed idle identity without resubmitting the task. The [controller](../../packages/api/taskboard-controller/README.md) owns prompt delivery and launch limits. This is a terminal handoff, not transcript import: native DSH Session state and Copilot terminal identity may coexist and neither automatically changes Taskboard planning status.

## Operational limits

The current query scans the in-memory domain table. Fractional numeric ranks may eventually exhaust one repeatedly bisected gap. Multi-process collaboration, indexed pagination, comments, attachments, transcript import, and a Host-owned native DSH start-work saga are deferred. Windows Terminal acceptance is best-effort; a later status refresh establishes whether Agency observed the Copilot process.

Design record: [Native Workspace Taskboard Agent Note](../../.agents/notes/implemented/feature/2026-09-01-native-workspace-taskboard.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [WorkspaceId](workspace.md)

Source: [`packages/workspace/taskboard/src/index.ts`](../../packages/workspace/taskboard/src/index.ts)

<a id="ctxtaskboardcontroller--taskboardcontroller"></a>

### `ctx.taskboardController` — `TaskboardController`

Host service backing the generated `ctx.remote.taskboard` namespace.

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
