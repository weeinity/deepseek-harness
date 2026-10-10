# Agent Note: Taskboard manual status control

Status: implemented

English | [中文](2026-09-25-taskboard-manual-status-control.zh.md)

## Problem

Board columns are durable planning state as well as execution projections. A user must be able to correct or organize that planning state without submitting a prompt or fabricating execution history.

The Todo-only restriction made the most common new card unable to enter In Progress, In Review, or Done through the board. The Client also disabled every drag in aggregate and search-filtered views even though a cross-column move remains well-defined within the task's own Workspace.

## Decision

Every active task exposes every status except its current one through `allowedManualStatuses`. The domain accepts each destination with the normal revision and rank-anchor validation. Same-column no-ops and reordering remain valid.

Manual moves never submit work, create an execution record, or change a conversation. [Execution-driven columns](2026-09-09-taskboard-execution-driven-columns.md) continue to move tasks from correlated execution and attention evidence, so later Host activity may reposition a manually moved card.

The Client keeps active cards draggable in single-Workspace, All workspaces, and search-filtered views. In aggregate or filtered views, a cross-column drop omits `beforeTaskId` and appends the task within its own Workspace. Same-column reordering and before-card placement remain available only in an unfiltered single Workspace.

The whole column accepts native drops, including its header, empty space, and cards. Only a payload from the current local drag can move a task; cancelled or external drags cannot mutate it. The destination highlights during dragging. A pending move temporarily disables further drags, and the Client displays only Host-committed placement. Failed moves retain that placement and show an error. The optional agent announcement describes the same manual destinations.

The `taskboard/manual-status-not-allowed` Remote error and its localized Client branch are absent because no valid manual destination produces that failure.

## Alternatives considered

**Keep the Todo-only rule with visible feedback.** This would explain the refusal but still prevent a user from correcting planning state without running the task.

**Permit every transition only in the Web Client.** Another Client or direct Remote caller would observe different behavior. The domain remains authoritative for status mutation and advertised destinations.

**Reorder cards in aggregate or filtered views.** Mixed Workspaces and hidden cards make one displayed position ambiguous. Those views support status changes but not ordering.

## Testing

Domain and controller tests cover every manual destination and detached destination projection. Component tests cover full-column drops, cancellation, payload rejection, pending saves, failure recovery, and Workspace-scoped ordering. The assembled browser scenario moves a task through every column, exercises filtered drops and same-column ordering, and verifies committed state after reload without dispatching work. The recorded-session Run scenario pins the optional agent announcement and manual status controls.

## Consequences

Users can organize the board independently of execution, while execution history remains the authority for what actually ran. Automatic observations can later move a card again. Aggregate and filtered drops append within the source Workspace instead of implying a global order.
