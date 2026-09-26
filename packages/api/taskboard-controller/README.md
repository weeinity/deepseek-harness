---
description: "Run saved Taskboard tasks in connected DSH or Copilot conversations, monitor execution history, and schedule Host-owned work."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-taskboard-controller

English | [中文](README.zh.md)

## Summary

Run saved tasks without keeping a browser open. Repeated runs continue the task's one connected DSH or Copilot conversation and retain separate execution records. Schedule work with an explicit timezone, inspect failures after reconnecting, and follow execution progress and requests for user input on the board. Optional settings announce Taskboard rules to agents and request idle-sleep protection.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [Web app bundle](../../bundle/web-app/README.md) mounts this controller with its Session, Session projection, LLM, Workspace, settings, and transport services. The LLM and Session projection services are required for pinned task models and presets. Presentation packages inject the React-free Client `taskboard` service instead of calling transport directly.

<a id="execution-and-connections"></a>
### Execution and connections

Create a task with an optional existing conversation, or let Run reserve its first conversation. Run Again continues that exact identity. Disconnect is required before replacement; a missing conversation is an error, not permission to recreate it. Connect and Open do not submit prompts. Copilot selection validates canonical Workspace membership through bounded Agency discovery; incomplete or unavailable discovery remains a visible failure.

Run submits the saved run prompt, or the title and nonblank description when that prompt is blank, with any frozen handover context. DSH settings that remain unpinned preserve the connected Session's choices. A task-specific model pin does not change the default for future Sessions. Copilot defaults to read-only; elevated choices require saved confirmation. Planning edits retain revision checks.

New tasks default to Todo. Accepted runs move to In Progress; waiting for user input, failure, or cancellation moves the task to In Review. Resumed execution returns to In Progress, and correlated successful completion moves the task to Done. Active tasks can be moved manually to any column without running them; same-column reordering remains available. Existing records and explicit creation statuses are preserved.

Questions and approvals in a linked DSH chat also move the task to In Review when the chat is continued outside Run, including tasks with no execution history. Open the linked Session to answer; resumed work enters In Progress, and the question's exact turn ending determines Done or In Review. This monitoring does not create or change execution records. Unlinked chats and archived tasks are untouched.

Caller cancellation is checked before the admission write begins. Once admitted, the Host owns the attempt even if the browser disconnects. Controller shutdown cancels discovery and waits for accepted operations to finish.

Archive and deletion reject open attempts. Restore keeps the schedule disabled. Duplicate creates an independent task without a connection, execution history, or permission confirmation. Current and retained historical conversation links remain navigation targets after archival. Deleting a task does not stop or delete its conversations.

### Host settings

The three Taskboard switches use the ordinary `taskboard` user-settings section to override composition defaults. Settings remain editable while Taskboard is disabled. `agencyCopilotLaunch` is deployment-only.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Admit manual and scheduled work; disabling does not delete conversations. |
| `announceToAgent` | `false` | Include Taskboard guidance in subsequent DSH model requests. |
| `preventIdleSleep` | `false` | Request protection while Sessions run or schedules remain armed. |
| `agencyCopilotLaunch` | `false` | Permit local Copilot execution and terminal navigation in an eligible deployment. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-taskboard-controller) owns deployment deadlines, recovery bounds, the lock directory, and the initial schedule timezone. Five-field cron stores its timezone with each task. Startup and long clock gaps skip missed occurrences; busy tasks or conversations do not accumulate a catch-up queue.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host commits an execution intent and provider cursor before submission. Recovery observes saved identities and receipts without resending an uncertain prompt. Admission, attention, and terminal observations update the task column atomically with execution records; waiting does not settle an attempt. A kernel-held lock excludes another configured Host and is released by process death; it is never stolen because a timestamp is old. The Host reloads task state after acquisition, verifies ownership before mutations, and retains the lock until admitted writes finish during shutdown.

Outside an open attempt, linked-chat monitors retain the live Agent and question turn rather than borrowing a past execution receipt. Revision-checked column writes preserve the task's inputs and history. Disconnect, archival, deletion, and new execution admission invalidate borrowed monitors, including disconnect/reconnect races. Disabling new Taskboard runs does not stop attention monitoring.

Reconnect baselines contain active and archived tasks plus runtime settings, scheduler, and power observations. Revisioned echoes cannot replace newer tasks. Permanent removal tombstones prevent delayed responses from restoring deleted identities. Business failures retain `taskboard/*` Remote codes and typed details; Client command failures retain their original Remote error.

The Host keeps its service dependencies as peers, like the Session and Workspace controllers. No companion is published. Dispatch and lifecycle checks own execution safety, and a periodic assertion cannot establish an external conversation's completion.

| Source | Responsibility |
|---|---|
| [Controller](src/index.ts) | Remote commands, connection validation, and terminal navigation. |
| [Coordinator](src/runtime/coordinator.ts) | Admission, scheduling, and receipt reconciliation. |
| [DSH adapter](src/runtime/dsh.ts) / [Copilot adapter](src/runtime/copilot.ts) | Provider input and completion evidence. |
| [Host lifecycle](src/runtime/index.ts) | Settings, ownership, and idle-sleep demand. |
| [Feed](src/feed.ts) | Reconnect baselines and ordered observations. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Taskboard domain](../../workspace/taskboard/README.md): durable inputs and revision rules.
- [Taskboard UI](../../client/ui-taskboard/README.md): task editing, history, and settings.
- [Taskboard subsystem](../../../docs/subsystems/taskboard.md): shared types and generated APIs.

<a id="model-experience"></a>
## Model Experience

### Task execution and optional guidance

#### What the model sees

Each admitted run supplies one ordinary user input to its connected provider, including the saved handover text when present. DSH records that input in its Session log; Copilot owns its conversation history. Optional DSH system-prompt guidance begins with `Taskboard keeps saved task definitions, connected conversations, and execution history.` Association and navigation add no input, and this package registers no Taskboard model tool.

#### Token effect

One prompt-sized user input per admitted run, plus frozen handover text and the opt-in system section when enabled.

#### KV Cache effect

Runs extend the existing conversation prefix. Changing the optional system section can invalidate a cached prefix; task-specific model changes remain Session-local.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

The Host must remain available for scheduling and monitoring.

- The feed belongs to one authoritative Host, not a multi-process collaboration service. Hosts sharing task data must use the same lock location.
- Recovery does not provide exactly-once external effects, automatic prompt retries, or Taskboard cancellation of borrowed conversations. Unprovable outcomes remain explicit failures or monitoring diagnostics.
- Waiting detection uses typed question and approval requests observed by the mounted adapter, not assistant prose. Existing waits cannot be attributed after an adapter reload. A correlated pending dynamic-package approval defers the original turn's success; later system-steering turns are not part of that execution. Unattended Copilot declines unsupported interactive requests and records a failed attempt in In Review instead of pretending that a human response can resume it.
- Unconfirmed provider shutdown retains the Host lock. Restart the owning process before starting another Host; do not delete its lock file.
- Copilot execution and terminal navigation retain the local Windows deployment fence. Execution uses the SDK-pinned CLI runtime rather than an arbitrary executable on PATH and requires native Copilot CLI sign-in; Agency authentication and bootstrap injection are not inherited. Close an interactive CLI holding the selected conversation before Run; Taskboard never steals its ownership. The [isolated interoperability test](tests/copilot-interop.e2e.ts) owns runtime compatibility evidence; unsupported permission or recovery operations fail rather than weaken policy.
- Idle-sleep protection does not schedule wakeups or guarantee operation through manual sleep, lid closure, shutdown, or loss of power. Armed schedules can require continuous protection.
- Agency discovery reads at most ten pages of 100 sessions and can have normal CLI startup side effects. `truncated: true` distinguishes an incomplete scan from confirmed absence.
- Workspace deletion hides retained task records; restoring a task does not restore a removed Workspace. Reconnection uses a full baseline rather than a persisted feed cursor.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
