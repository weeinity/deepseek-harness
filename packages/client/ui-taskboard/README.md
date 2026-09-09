---
description: "Native Web Taskboard: a durable five-column Workspace board linked to DSH Sessions and live execution state."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-taskboard

English | [中文](README.zh.md)

## Summary

This package renders the native Taskboard mode in the DSH Web GUI. It contributes a sidebar footer launcher and a full-height main surface while the standard sidebar remains available. Cards come from the Host-authoritative Taskboard Client service, retain durable Workspace status and ordering, and may link to a DSH Session. Running Sessions, background jobs, and blocked Goals decorate cards without changing their durable status.

## Table of Contents

- [Use this package](#use-this-package)
- [Associate an existing Copilot CLI session](#associate-an-existing-copilot-cli-session)
- [Start a task with Agency Copilot](#start-a-task-with-agency-copilot)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the Taskboard domain, Taskboard Controller, and this client plugin in the Web profile. Open **Taskboard** from the sidebar and use **New task** in the board header. The compact creation dialog asks for a required Title, optional Description, Workspace, and optional Copilot CLI session; **Create** saves the task and opens its centered details dialog. Clicking a card opens the same details dialog, with editable title, description, priority, and labels, linked Sessions, status controls, Archive, and Delete. Workspace remains read-only after creation.

Cards show a description preview, update time, and the explicit Backlog, Todo, In Progress, In Review, or Done status. Live DSH activity and the latest Agency observation appear separately; an idle Copilot terminal does not mark the task Done. Dragging or the details status controls changes the planning status.

Select **Archive** in task details to remove the card from the active board. **Archived (count)** opens a full-width list with the same search and Workspace filters; **Back to board** returns to the columns without clearing those filters. Archived details are read-only and retain navigation to an existing DSH Session. The archive comes from durable Host records and survives refresh.

Select **Delete** in active or archived task details, then confirm to permanently remove the Taskboard record. Linked DSH and Copilot sessions and running terminals remain untouched. Before submitting, **Cancel**, Close, or Escape returns to the unchanged draft; a failed deletion keeps the confirmation open with an error and permits an explicit retry.

The board uses Dashi Taskboard's local-first issue-board interaction as a product reference. This implementation is native DSH code and does not vendor upstream source. Dashi Taskboard is Apache-2.0 licensed: <https://github.com/chuspeeism/dashi-taskboard>.

<a id="associate-an-existing-copilot-cli-session"></a>
## Associate an existing Copilot CLI session

In **New task**, choose the Workspace, select an existing **Copilot CLI session (optional)**, and select **Create**. The picker shows local sessions from that Workspace with their summaries, identity prefixes, and current ownership status. Changing the Workspace clears the selection. **Refresh session list** repeats discovery; unavailable or incomplete discovery is shown explicitly.

To change a saved association, open the task, select another Copilot CLI session, and select **Save**. Choose **No session linked** and save to clear it. Task content and the selected link are saved together; Host validation failures retain the draft and show an error inside the dialog. An existing link remains visible when discovery is unavailable, and unchanged links do not prevent metadata edits.

Associations survive reload and remain independent of the native DSH Session link. Selecting, saving, or clearing an existing association does not launch a terminal, resend task instructions, or change the planning status. Save a changed selection before using the terminal actions below.

<a id="start-a-task-with-agency-copilot"></a>
## Start a task with Agency Copilot

1. Register the repository directory as a DSH Workspace and create the task under that Workspace. The Copilot terminal always starts in the task Workspace; tasks cannot be reassigned implicitly.
2. Open the task card and select **Start with Copilot** under **Agency Copilot terminal**. The Host generates a new UUID, stores it independently of any DSH Session link, and launches an interactive Copilot terminal with the task title and description submitted as its first message. Normal Agency Workspace configuration and tool approvals apply.
3. The task moves to **In Progress** after the link and launch handoff succeed. Closing DSH does not intentionally own or stop the user terminal.
4. Use **Refresh status** to observe **Copilot running**, **Ready to resume**, or a diagnostic state. **Copilot running** means the CLI has acquired the session, not that a model request is active. **Open/Resume Copilot** resumes an idle session without resubmitting the task; an already-running identity is never duplicated.
5. **Unlink** removes only the Taskboard identity. It never terminates Copilot. Native **Start work/Open session** remains a separate DSH conversation flow and may coexist on the same task.

The launch controls are enabled only on the local DSH page. The browser never supplies executable paths, command arguments, environment values, or working directories. Existing-session selection supplies an identity for Host validation; fresh launch always uses a Host-generated UUID.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin fills the layout-owned keyed `main.surface` cell `taskboard` and the additive `sidebar.footer.action` row. The two registrations share the Client Taskboard observable but receive separate minimal inject faces. View-only state—filter, search, selected task, and dialog drafts—stays local to React. Business tasks remain in the controller's React-free Client model.

Opening Taskboard obscures rather than unmounts Conversation and Details. AppFrame keeps their grid geometry stable and passes `active:false` to suspend document-level attachment behavior. Explicit Session navigation opens the Session first, then closes Taskboard.

<a id="model-experience"></a>
## Model Experience

### Taskboard presentation

#### What the model sees

Nothing. The `main.surface` plugin renders Taskboard state for a human and registers no tool, prompt, or model-visible Session event.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

None; browser presentation state never enters a provider request.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Taskboard status is explicit; live Session, Job, Goal, and Subagent state never completes a task automatically.
- Dragging supports column and before-card placement; keyboard reordering is deferred.
- Comments, attachments, GitHub/Linear sync, and multi-user cloud collaboration are deferred.
- Copilot launch/resume is a visible Windows Terminal handoff, not transcript import or browser control; status refresh observes Agency's local session store.
- Archived tasks cannot be restored, edited, or run from this view. Scheduling, permission selectors, and per-run execution history are not part of the native Taskboard.
- Focus enters the board on open; a complete focus trap and launcher restoration remain follow-up accessibility work.

<a id="dev-note"></a>
### Dev Note

None.
