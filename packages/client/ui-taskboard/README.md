---
description: "Manage Workspace tasks, exclusive DSH or Copilot connections, saved execution inputs, schedules, and run history in the native Web Taskboard."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-taskboard

English | [中文](README.zh.md)

## Summary

Organize Workspace tasks across five workflow columns and run their saved prompts through DSH or Copilot. Each task keeps one current conversation, durable execution history, optional scheduling, and reviewed handover context. Run Again continues that conversation until you explicitly disconnect. Priorities, labels, archives, and editable copies support planning alongside execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Run a task](#start-a-task-in-dsh)
- [Connect an existing conversation](#associate-an-existing-copilot-cli-session)
- [Execution options and scheduling](#start-a-task-with-agency-copilot)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Taskboard** from the sidebar in a Web composition containing the [Taskboard controller](../../api/taskboard-controller/README.md). **New task** opens an unsaved draft with title, description, Workspace, priority, labels, separate run prompt, execution settings, and an optional existing connection. **Save and Close** saves in **Todo** and closes the dialog; **Save** saves and continues editing. Neither starts work. **Cancel** discards the creation draft without changing the board. Clicking a card opens its details.

Admitted runs move tasks to In Progress. Success moves them to Done; failure, cancellation, or waiting for user input moves them to In Review. Resumed execution returns them to In Progress.

Drag a card onto another column's header, empty area, or card to change its saved status without running it. The destination highlights during the drag. Status changes also work in **All workspaces** and search-filtered views; same-column reordering and before-card placement require an unfiltered single Workspace. In that view, dropping below the last card appends it.

A dropped card stays at its committed position until the Host update arrives. Another drag waits for the save to settle. Failed saves show an error and retain the committed task. Keyboard users can open a card and use its status controls; save draft edits first.

Column dots and task-status badges use grey for Backlog, indigo for Todo, blue for In Progress, amber for In Review, and green for Done. The same palette applies to light and dark themes and archived cards.

Questions in a linked DSH chat also move its task to In Review when you continue the chat outside Run. Use **Open session** to answer. The [Host monitor](../../api/taskboard-controller/README.md#execution-and-connections) follows resumption and completion without adding execution history or linking unrelated chats.

**Archive** and **Delete** appear only for saved tasks, never in creation drafts. **Archive** moves a task into the filtered archive list. Archived tasks are read-only; **Restore** returns them to the board with scheduling disabled. **Delete** requires confirmation and removes only the task record, not its conversations.

Draft saves use the revision captured when editing begins. Incoming changes cannot silently authorize an older draft; after a revision conflict, reopen the task or preserve your edits with **Edit as copy**.

Creation and details dialogs cannot be dismissed while a command is pending. **Save and Close** precedes **Save** and closes only after a successful save. Failed commands retain the draft and error for retry.

**Duplicate task** opens an editable new-task draft in the source task's column, without connection, execution history, or permission confirmation. Unsaved edits can become a copy through **Edit as copy**. Optional source archival is a separate awaited operation: if it fails, the created copy remains and the dialog offers retry without creating another copy.

**Taskboard settings** remains reachable through the sidebar launcher and board header even when Taskboard is disabled. Its three Host-owned switches control Taskboard availability, agent announcements, and idle-sleep protection. Power status, scheduler errors, and execution-monitor errors come from the Host; no browser defaults replace a missing runtime snapshot.

The visual board uses Dashi Taskboard as a product reference without vendoring its source. Dashi Taskboard is Apache-2.0 licensed: <https://github.com/chuspeeism/dashi-taskboard>.

-----

<a id="start-a-task-in-dsh"></a>
## Run a task

Choose DSH or Copilot, save the execution inputs, and select **Run**. A blank run prompt uses the title and nonblank description, separated by a blank line; an explicit prompt overrides both. **Run Again** remains available after an attempt settles and continues the same connected conversation until **Disconnect**. Unsaved inputs, unresolved connection choices, or an open attempt block another run.

The Host owns admission and dispatch. A successful DSH dispatch acknowledgement opens Chat without waiting for model completion; failures leave the dialog visible. Details display pending, running, succeeded, failed, and cancelled attempts newest first, including timestamps, saved input, errors, and individual conversation links. Pending conversation reservations cannot be opened. A missing connected DSH Session produces an explicit failure rather than replacement.

-----

<a id="associate-an-existing-copilot-cli-session"></a>
## Connect an existing conversation

A disconnected task exposes one provider picker. DSH choices come from the selected Workspace; Copilot discovery lists matching local sessions and reports unavailable or incomplete scans. **Connect** associates the selected conversation without running it. Current connections are read-only; use **Disconnect** before replacing one. A task retaining two legacy choices requires an explicit selection.

**Open session** navigates to DSH Chat. **Open/Resume Copilot** requests the existing Agency terminal handoff. Neither action sends the task prompt or recreates a missing conversation; failures remain visible. History links retain their own conversations after disconnection, reconnection, or archival. An already-running Copilot outcome reports that no additional terminal opened, including when execution is headless. Copilot terminal navigation is available only when the Client and Host permit local launch; run availability comes from the Host execution catalog.

DSH Sessions with a current task connection show **Open Task** as a compact, rounded blue header button with a white checkbox icon, matching the height of the adjacent Session controls. Select it to return to Taskboard and open the task's details. The board clears search and selects the task's Workspace and active or archived view. If several tasks connect to the Session, choose one from the menu by task code and title. Archived details remain read-only; a task removed before navigation produces an error. Opening a task does not run it.

-----

<a id="start-a-task-with-agency-copilot"></a>
## Execution options and scheduling

The board loads the Host's preset, permission, and model catalog. Broken presets remain visible but cannot be selected. Copilot accepts an explicit model ID rather than invented catalog entries. Connected tasks and unresolved legacy choices lock Workspace, provider, and preset selection. Open attempts lock execution-input editing. Title, description, labels, and priority stay editable; permitted status changes do not alter the frozen attempt.

Scheduling offers a five-field cron expression, time zone, enabled switch, and daily-at-nine, hourly, ten-minute, and Monday-at-nine presets. The Host validates expressions and supplies next-run and last-trigger timestamps. Invalid input remains in the draft with the server's error.

Frozen handover context contains goal, progress, next action, references, source conversation, and freeze time. Unrelated edits preserve it. Review the saved permission and handover, select the explicit review checkbox, and confirm before running with elevated permissions. A newer task revision invalidates an unsent review.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin contributes the layout-owned `main.surface` Taskboard entry, a sidebar footer launcher, and Session-header navigation. Entries consume the controller's identity-stable observable through framework-bound hooks. Session and Workspace data use the standard framework hooks; dialog drafts and filters stay component-local. The header derives links from current task connections; a shared root store carries only a one-shot task id, not task records.

Only the Host Run command submits work. Client callbacks keep association, terminal navigation, and planning mutations separate. Host task updates determine column placement; the projected `allowedManualStatuses` determines manual controls. The [controller](../../api/taskboard-controller/README.md) owns the Remote projection and revision ordering; the [domain](../../workspace/taskboard/README.md) owns persistence and execution rules.

No runtime invariant companion is published: this presentation plugin has no independent event stream or durable state to reconcile.

</details>

<a id="model-experience"></a>
## Model Experience

### Task execution requests

#### What the model sees

With a saved run prompt such as `Run these instructions`, **Run** asks the Host to dispatch that text. The [controller](../../api/taskboard-controller/README.md#model-experience) owns model-input assembly. Viewing, connecting, disconnecting, opening conversations, and editing planning state do not submit model input.

#### Token effect

Board rendering adds no tokens. Host-dispatched prompts and handover context consume ordinary input tokens.

#### KV Cache effect

Viewing Taskboard does not change conversation history. Run Again addresses the same conversation; the provider owns request caching.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Keyboard card reordering, comments, attachments, GitHub/Linear synchronization, and multi-user cloud collaboration are deferred.
- Copilot terminal navigation is a local Agency handoff, not a browser transcript viewer.
- Archiving an original after copying is deliberately non-atomic; failures require a separate retry.
- Full-board focus trapping and launcher-focus restoration remain accessibility follow-up work.

<a id="dev-note"></a>
### Dev Note

None.
