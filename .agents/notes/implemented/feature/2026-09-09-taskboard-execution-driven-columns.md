# Agent Note: Taskboard execution-driven columns

Status: implemented

English | [中文](2026-09-09-taskboard-execution-driven-columns.zh.md)

## Problem

A task's board column must show whether its execution is working, needs user input, or has finished. Requiring a separate manual move after Run or completion leaves the board stale.

## Decision

This note supersedes the manual-only status decisions in [native Taskboard](2026-09-01-native-workspace-taskboard.md) and [executions and exclusive conversations](2026-09-09-taskboard-execution-and-conversations.md). Those notes retain their presentation, Workspace, durable receipt, and conversation ownership rationale. [Manual status control](2026-09-25-taskboard-manual-status-control.md) supersedes only this note's Todo-only manual restriction; this note continues to own automatic execution and attention updates.

Omitted creation status defaults to Todo. Explicit creation choices, copies, and existing records retain their supplied status. There is no historical status migration.

The domain updates columns in the same durable write as execution admission or observation. Accepted manual and scheduled runs enter In Progress. Waiting for user input enters In Review without settling the execution; resumed work returns to In Progress. Exact successful completion enters Done. Failed and cancelled attempts enter In Review.

Execution history remains separate from the task column. Done denotes successful execution, not independent human review or proof that every task requirement was fulfilled. Generic conversation idle state is not completion evidence. Receipt correlation and recovery without resubmission remain governed by the execution decision.

An attributed pending dynamic-package approval defers publishing the original turn's success until that request is answered. Later system-steering turns do not acquire the original execution's receipt. Attribution requires the mounted adapter's live request witness; registry-local IDs and Session history alone cannot reconstruct waits after adapter reload.

Attention belongs to the current linked DSH conversation even when no Taskboard attempt is open. A typed question or approval captures its live Agent and exact turn. The task enters In Review, resumes In Progress after the answer, and follows that turn's successful or unsuccessful ending without creating an execution record. Unlinked chats and archived tasks are excluded. A later turn cannot replace the captured result; a new pending question can establish its own monitor.

The Host invalidates these borrowed monitors on disconnect, archival, deletion, and new execution admission. Revision and connection checks refuse stale column writes. Disconnect/reconnect invalidation observes committed task changes rather than comparing only the final connection ID, so an old callback cannot regain authority when the same Session is reattached. Failed writes retain monitoring for retry; ownership loss blocks writes without cancelling or answering borrowed work.

Every active task can move manually to any other status, and same-column reorder remains valid. The domain derives `TaskboardTask.allowedManualStatuses` from the shared status order, so Clients do not maintain another transition table. Host activity may reposition a manually moved card while its execution remains open.

Automatic column changes append the card to the destination column. Unchanged activity observations do not change revision, timestamps, or rank. Replayed admission and repeated terminal acknowledgement do not undo later manual edits. Settlement requires neither Workspace discovery nor provider availability.

## Alternatives considered

**Keep all columns under manual control.** This preserves a strict review gate but leaves accepted and completed executions visually stale. The requested workflow gives execution and attention observations responsibility for column updates.

**Move every terminal execution to Done.** Failures and cancellations need user attention and must remain distinguishable from success.

**Restrict manual transitions.** This would keep execution admission as the only route from Todo into active or completed columns, but it would prevent explicit planning corrections. [Manual status control](2026-09-25-taskboard-manual-status-control.md) keeps execution history separate while allowing those corrections.

**Treat waiting for input as a terminal failure.** A supported question or approval can resume the same execution. An open waiting observation preserves that continuity; unsupported provider interaction remains an explicit failure.

**Observe only Taskboard execution receipts.** A linked chat can ask a question before its first Run or during a later manual continuation. Reusing an old receipt would corrupt attribution; a separate read-only question-turn monitor supplies attention without inventing an attempt.

## Testing

Domain tests cover default creation, explicit status preservation, manual destination projection, atomic status and rank changes, repeated observations, request replay, and settlement after Workspace removal. Coordinator tests cover In Progress, waiting In Review, resumed In Progress, and Done without resubmission, plus failed and cancelled recovery. Client and assembled browser tests cover destination controls and execution-driven card placement.

Linked-chat regressions cover empty and settled history, overlapping questions and approvals, exact-turn completion, durability failures, ownership loss, and task mutation races. The shipped-profile browser scenario uses genuine recorded model streams and the real question answerer, observes the In Review card, and answers through the Chat UI; an unlinked-chat control proves that monitoring neither creates tasks nor associates conversations.

## Consequences

The board reflects Host-observed work without a connected browser. In Review combines pending user input with failed or cancelled work; execution records explain Taskboard runs, while the linked Chat owns manual-turn details. The Host must remain available to observe changes, and a column update can lag the underlying provider until its next observation.
