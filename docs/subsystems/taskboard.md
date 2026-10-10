# Taskboard

English | [中文](taskboard.zh.md)

Taskboard keeps durable Workspace task definitions and their execution records. A task has at most one current conversation: a DSH Session or a Copilot CLI session. Repeated runs continue that conversation. New tasks start in Todo; execution and user attention update their board columns.

Source: [`packages/workspace/taskboard/src/types.ts`](../../packages/workspace/taskboard/src/types.ts)

## Durable records

`TaskboardTask` contains the planning fields, saved run prompt, explicit execution choices, optional schedule and frozen handover, and bounded execution history. Its derived `allowedManualStatuses` supplies every status except the current one to Clients. `TaskConnection` discriminates DSH and Copilot identities. A different current identity requires explicit disconnect. Preserved unresolved connection choices block execution until the user selects one.

`TaskExecution` snapshots the prompt, settings, handover, Workspace, and conversation for one admitted request. Its pending, running, succeeded, failed, or cancelled outcome is stored separately from the task column. Admission moves the task to In Progress, waiting for user input moves it to In Review without settling the attempt, and resumed work returns it to In Progress. Successful settlement moves it to Done; failure or cancellation moves it to In Review. Provider receipts support recovery without prompt resubmission. Historical records retain their own conversation identities after the current connection changes.

The [domain package](../../packages/workspace/taskboard/README.md) owns record validation, bounded retention, request deduplication, revision checks, and schedule admission. It publishes changes only after persistence commits. Archive is independent of planning status; restore disables scheduling. Neither task deletion nor disconnect deletes conversations.

## Browser transport and UI

[Taskboard Controller](../../packages/api/taskboard-controller/README.md) owns Host execution, cron evaluation, completion monitoring, and the reconnecting Remote stream. Baselines include active and archived tasks plus settings, scheduler, and power observations. The Client preserves newer task revisions and deletion tombstones against delayed responses.

[ui-taskboard](../../packages/client/ui-taskboard/README.md) registers a keyed `main` panel, a `sidebar.panellist` launcher, and a linked-Session header action. The layout service owns active-panel navigation, while the shared root store carries only the requested task identity. Explicit Session navigation uses the Workspace navigation service and never submits task input.

The [UI guide](../../packages/client/ui-taskboard/README.md) describes existing-conversation selection, Run and Run Again, execution history, editable copies, archives, handover, and settings. Conversation navigation is distinct from execution and never submits the saved prompt.

The Host remains responsible after a browser disconnect. Kernel ownership prevents competing configured runners; provider-specific evidence determines execution outcomes. Scheduling skips missed or busy occurrences instead of accumulating retries. The controller reference owns permission, recovery, compatibility, and idle-sleep limitations.

## Operational limits

Queries scan the in-memory domain table, and repeatedly bisected fractional-rank gaps can exhaust numeric precision. Multi-process collaboration, indexed pagination, comments, attachments, and Copilot transcript import are not provided. SQLite durability does not turn the domain's process-local revision check into SQL-level compare-and-set.

Design records: [Native Workspace Taskboard](../../.agents/notes/implemented/feature/2026-09-01-native-workspace-taskboard.md), [execution-driven columns](../../.agents/notes/implemented/feature/2026-09-09-taskboard-execution-driven-columns.md), and [manual status control](../../.agents/notes/implemented/feature/2026-09-25-taskboard-manual-status-control.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [WorkspaceId](workspace.md)

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
