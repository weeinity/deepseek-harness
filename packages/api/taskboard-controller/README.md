---
description: "Taskboard Remote controller: revision-checked commands and reconnect-safe task state for Web clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-taskboard-controller

English | [中文](README.zh.md)

## Summary

This package exposes the Host Taskboard through the generated `taskboard` Typert Remote namespace and provides its React-free Client model. Unary create, update, move, archive, delete, and Agency Copilot link calls install immediate echoes; a reconnecting stream begins every physical generation with a complete task baseline and then applies ordered upsert/remove increments. Its Host-only Agency adapter validates selected local Copilot identities, generates fresh identities for Start, and performs fixed Windows Terminal handoffs without accepting browser-supplied commands, paths, flags, or environments.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `dsh-taskboard`, the API Gateway, Connection, API Remotes, and a local subprocess provider. Presentation packages inject the Client `taskboard` service and subscribe to its identity-stable snapshot rather than calling transport directly. `startAgencyCopilot` persists a Host-generated UUID before handing `agency copilot --session-id <uuid> --interactive <task>` to Windows Terminal in the task Workspace. The initial prompt contains the persisted title, followed by a blank line and the description when nonempty; normal Copilot tool approvals remain enabled. `openAgencyCopilot` reports an already-running session, resumes an observed idle session with `--resume=<uuid>` without submitting another prompt, or retries the same UUID with the current task content when a complete scan proves the first launch never materialized. Agency status failures remain separate from durable task loading.

`listAgencyCopilotSessions` returns existing local sessions whose canonical folder matches the registered Workspace, including optional summaries and idle/in-use status but no folder paths. Create and update accept a selected UUID only after the Host finds that exact Agency row in the task Workspace; content and the link commit together. Selection never launches or resumes Copilot, submits a prompt, or changes planning status. The DSH Session link remains independent. An omitted or unchanged Agency link needs no discovery; an update with `null` clears it. Link updates share the task's archive/Start/Open/Clear lock and recheck revision CAS after discovery. Cancellation prevents a queued write from starting.

Lists and reconnect baselines include both active and archived tasks in registered Workspaces. Archive commits arrive as upserts and remain in the Client snapshot after refresh; `archivedAt` distinguishes archive rows without changing their planning status. Presentation packages filter archived rows out of active boards and Agency refresh requests. Archived tasks reject content, movement, link, and Copilot launch operations; the Client discards their transient Agency observations, including delayed responses. Task revisions cannot roll back through delayed echoes or baselines. A complete baseline removes absent rows, and task-record or Workspace deletions emit removal tombstones.

`delete` permanently removes an active or archived Taskboard record at its expected revision without changing its Workspace, native DSH Session, Agency session, or terminal. It shares the task's Agency-operation lock and checks cancellation before admitting the durable deletion. The Client removes the row and its Agency observation only on success; Remote failures and rejected requests retain existing state without automatic retry. The removal receipt and feed tombstone use `Number.MAX_SAFE_INTEGER`, preventing delayed task echoes, baselines, or Agency observations from restoring the deleted identity.

<a id="model-experience"></a>
## Model Experience

### Taskboard transport

#### What the model sees

A fresh external Copilot launch receives the task title and description as its initial user message. Selecting an existing session sends no message. Copilot owns that conversation's logging; the linked DSH Session receives no message. The `taskboard` Remote registers no DSH tool or request-context contribution.

#### Token effect

One task-sized user message per fresh external Copilot launch. No additional DSH request tokens.

#### KV Cache effect

No DSH cache changes. The external Copilot session includes the submitted task in its own conversation history.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Reconnection repairs state with a full baseline rather than a durable cursor.
- The feed reflects one authoritative Host process; storage-domain changes are not cross-process notifications.
- Workspace deletion hides its active and archived tasks from lists and streams but retains their durable task records. The controller provides no restore command.
- Windows Terminal handoff proves only that the broker accepted the request; refresh Agency status to observe whether Copilot acquired the session.
- Windows command-line length limits apply to task submission. An oversized prompt fails explicitly instead of being truncated; shorten the task title or description before retrying.
- Agency status discovery runs the installed CLI with bounded output and therefore still has Agency's normal invocation logging/startup side effects.
- Discovery reads at most ten pages of 100 sessions. `truncated: true` reports remaining pages; missing identities in an incomplete scan cannot be selected. Malformed or unavailable Agency discovery rejects explicitly rather than returning an empty list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
