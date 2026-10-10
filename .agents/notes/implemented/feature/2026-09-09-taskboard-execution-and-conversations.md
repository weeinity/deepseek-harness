# Agent Note: Taskboard executions and exclusive conversations

Status: implemented

English | [中文](2026-09-09-taskboard-execution-and-conversations.zh.md)

## Problem

A saved task outlives any one agent execution. Creating a Session or opening a terminal does not prove that the agent accepted the task, finished it, or produced a reviewed result. Browser-owned orchestration also cannot reliably monitor work after disconnect or decide whether an interrupted submission is safe to repeat.

A task with independent DSH and Copilot links has no unambiguous target for Run Again. Replacing the conversation on each run discards useful context; automatically recreating a missing conversation can repeat work while concealing lost history.

## Decision

The [native Taskboard presentation decision](2026-09-01-native-workspace-taskboard.md) continues to own layout and Workspace placement. This note owns execution and conversation policy in place of its independent-link and terminal-owned launch decisions. [Execution-driven columns](2026-09-09-taskboard-execution-driven-columns.md) supersedes this note's manual-only status policy; its remaining ownership and recovery decisions stay active.

Each task has one current DSH or Copilot conversation. Run Again continues it until explicit disconnect. Historical executions retain their own identities. Existing dual-link records preserve both choices and block execution until the user selects one; migration does not choose for the user or invent execution history.

The task definition owns its editable prompt and explicit execution choices. Each admitted request snapshots its effective inputs, Workspace, conversation, handover, and asserted initiation source. Version-1 task reads preserve the title-and-description input by materializing an explicit prompt. Released Session log generations are unchanged.

**Superseded prompt default:** Blank prompts use only the title; description remains planning text. [Default run prompts](2026-09-10-taskboard-default-run-prompt.md) owns the active fallback.

The Host commits a pending attempt and reserved identity before provisioning or submission. It persists provider recovery evidence before sending input, and records acceptance separately from completion. A terminal observation remains available until Taskboard settlement commits; provider attachments can then be released. A process interruption never authorizes automatic prompt resubmission.

Request receipts use caller-owned identities and are retained independently of displayed execution history. Replays are checked before mutable defaults or fresh identities are resolved. A reused key cannot name different intent; stale requests still face revision or scheduled-occurrence checks when a receipt expires.

One configured Host owns execution through a kernel-held file lock. Process death releases ownership; elapsed time never proves that a live or suspended owner has stopped. The Host reloads cached task state after acquisition. Bound mutations verify ownership, and shutdown revokes new writes before draining admitted writes and releasing the lock. This excludes stale-cache writes as well as simultaneous dispatch. Shared task data requires a shared lock location.

Manual runs and cron use the same admission and provider operations. Cron stores an explicit IANA timezone and five numeric fields. Startup, backward-clock recovery, and long gaps skip missed occurrences. Busy tasks and conversations skip occurrences rather than queueing catch-up work. Restore and duplication leave scheduling disabled.

DSH input uses the shared Session Controller and exact inbox/turn evidence. Unpinned settings preserve connected Session choices; task-specific model selection does not rewrite the default for new Sessions. Copilot uses the supported SDK execution interface, bounded Agency discovery, and exact conversation identities. Permission setup must succeed before input; read-only is the unattended default, and elevated task choices require explicit saved confirmation.

Frozen handover text is ordinary user input, not a system instruction or an authorization grant. The handover source label identifies the asserted source rather than authenticating a person. Permission or handover changes invalidate the relevant confirmation. Planning edits do not rewrite the immutable inputs of an open execution.

**Superseded status policy:** Execution outcome and task status remain separate. An agent finishing does not move a card to In Review or Done. The [column decision](2026-09-09-taskboard-execution-driven-columns.md) owns the active workflow. Association, navigation, disconnect, archive, restore, and task deletion do not submit work or erase conversations. Open never recreates missing history.

Optional settings announce Taskboard rules through the normal logged DSH system prompt and request idle-sleep protection while work or armed schedules exist. They do not install a Taskboard model tool, schedule machine wakeups, or guarantee operation through explicit sleep or shutdown.

## Alternatives considered

**Keep browser-owned create, link, prompt, and monitor steps.** A disconnected browser cannot own durable dispatch or completion. The Host owns those operations while the Client remains a projection and command caller.

**Use terminal creation as execution acceptance.** Terminal handoff confirms only broker acceptance. Headless SDK execution supplies provider receipts and monitoring; an existing conversation can still be opened interactively after owned execution releases it.

**Keep both links or create a new conversation on every run.** Two links make dispatch ambiguous, while replacement loses context. Explicit disconnect makes the change deliberate and preserves historical navigation.

**Retry an uncertain submission automatically.** External acceptance and Taskboard persistence do not share a transaction. A duplicate could repeat file or network effects, so unknown acceptance remains visible instead of being silently retried.

**Expire an ownership lease by timestamp.** A suspended process can remain alive beyond the lease and later resume writing. Kernel ownership survives suspension and releases on death without racy directory removal.

**Use the existing Session reminder scheduler.** Session-local reminders require their live Agent and do not own Host-wide cold-conversation cron dispatch. Taskboard scheduling instead shares durable task admission.

**Derive Done from agent success (superseded rejection).** Execution cannot establish human review or fulfillment of the task. The [column decision](2026-09-09-taskboard-execution-driven-columns.md) accepts that limitation and gives Done an execution-success meaning.

## Testing

Required regression coverage includes revision and request races, preserved dual-link choices, monotonic attempts, immutable handover input, same-conversation reruns, failed settlement writes, cold recovery without resubmission, and ownership acquisition with a fresh durable snapshot. Provider tests distinguish exact input acceptance from generic idle state and preserve evidence until settlement.

Kernel tests exercise contention and crash release in private directories. Native power tests replace actual inhibition and prove quiescent teardown. The [assembled Taskboard scenario](../../../../snapshots/web/taskboard-start-work/) covers both repeated execution and the logged opt-in announcement and handover; the [management scenario](../../../../apps/web/tests/taskboard-management.e2e.ts) covers the retained UI workflow. Installed Copilot interoperability has a separate [isolated provider test](../../../../packages/api/taskboard-controller/tests/copilot-interop.e2e.ts).

## Consequences

Task definitions, run history, and conversation ownership are explicit and restart-visible. The cost is a Host lifecycle with provider-specific recovery and a required single-writer configuration. Bounded receipts and evidence do not promise exactly-once external effects, and unsupported provider operations fail rather than weakening permissions or guessing success.

The API controller retains Host service peers like the Session and Workspace controllers. SQLite admits only declared compatible per-record version advancement; older writers must be closed, and a committed upgrade does not enable downgrade support. Collaborative multi-process editing still requires SQL-level conditional writes and a durable change feed.
