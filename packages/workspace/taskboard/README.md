---
description: "Durable Taskboard service: revision-checked Workspace tasks with five-column ordering over the storage domain form."
kind: "package-reference"
---

# @deepseek-ai/dsh-taskboard

English | [中文](README.zh.md)

## Summary

This package owns durable Taskboard tasks. Each task has a stable UUID, Workspace, five-state status, rank, positive revision, timestamps, labels, priority, an optional native DSH Session link, and an independent optional Agency Copilot CLI session identity. Mutations serialize through the service and compare the caller's expected revision at the operation's queue slot before one task row is written or removed durably.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-storage`, a storage backend, `dsh-storage-domain`, `dsh-workspace`, and this package. The Web profile routes the `taskboard` domain to SQLite. Consumers call `create`, `update`, `move`, `archive`, `delete`, `get`, and `list`; archived tasks retain their last board status and are hidden by default. Create and update commit content and an optional Agency Copilot UUID together. Callers must validate newly selected Agency identities against the task Workspace; the [Taskboard controller](../../api/taskboard-controller/README.md) owns local Agency discovery. Update omission retains the Agency link, `null` clears it, and the DSH Session link remains independent. The dedicated revision-checked `setAgencyCopilotSession` method supports Host Start/Clear operations. The version-1 disk schema validates the optional UUID.

`delete` permanently removes an active or archived task at its expected revision and returns its UUID with the feed's permanent removal revision, `Number.MAX_SAFE_INTEGER`. It never changes the Workspace, native DSH Sessions, Agency sessions, or terminals. Missing tasks and revision conflicts reject before storage writes; storage failure leaves the record available for an explicit retry. Cancellation prevents a queued deletion from starting, but a storage deletion already in progress settles normally.

<a id="model-experience"></a>
## Model Experience

### Taskboard records

#### What the model sees

Nothing. `ctx.taskboard` records remain Host application data and this package registers no tool, prompt, or request-context contribution.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

None; Taskboard records never enter a provider request.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Revision CAS and change observation are single-process because the generic storage-domain backend performs unconditional row writes.
- Querying scans the authoritative in-memory table; indexed pagination and multi-process SQL CAS require a dedicated relational provider.
- Fractional numeric ranks can eventually exhaust a gap after repeated insertion at one exact position; rank compaction is deferred.
- Deleting the highest retained ordinal permits its reuse by a new task; UUIDs, not ordinals, identify records.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
