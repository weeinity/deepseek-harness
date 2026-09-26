# Agent Note: Native Workspace Taskboard mode

Status: implemented

English | [中文](2026-09-01-native-workspace-taskboard.zh.md)

## Problem

DSH exposes durable Workspaces and Sessions plus live Goal, Job, and Subagent state, but it has no host-wide issue board. Session `todo_write` is a transient three-state model checklist and cannot represent tasks that exist before a Session, human review, stable identity, ordering, or durable project planning.

A separate Taskboard must not replace the Web shell or Conversation slot. It also cannot use a full-frame generic overlay because the standard sidebar must remain available for navigation. Unmounting Conversation would discard drafts and scroll state; hiding it with `display:none` would collapse geometry while streaming scroll observers remain live.

## Decision

Ship a native, Workspace-owned five-column Taskboard with three layers: `dsh-taskboard` owns revision-checked durable records over storage-domain; `dsh-api-taskboard-controller` exposes commands plus a reconnecting baseline-and-increment stream; `dsh-client-ui-taskboard` renders the board. The [execution and exclusive-conversation decision](2026-09-09-taskboard-execution-and-conversations.md) supersedes this note's independent-link and terminal-owned launch policies; this note remains the owner of presentation and planning rationale.

The Web profile mounts SQLite as a second storage backend and routes only the `taskboard` domain to it. Base profiles retain JSON as their default. Planning records use stable UUIDs, Workspace identity, explicit `backlog|todo|in_progress|in_review|done` status, rank, positive revision, timestamps, optional priority and labels. Archive remains orthogonal to status.

AppFrame owns a root-scoped keyed `main.surface`. Its selected id lives in the root layout store. The active entry spans the center and details grid tracks while Sidebar remains uncovered. Conversation and Details stay mounted at their original dimensions but become invisible, inert, and inaccessible. AppFrame sends `active:false` into Conversation so attachment document listeners and body-portaled draft previews dismiss rather than escape above Taskboard.

The sidebar launcher registers in `sidebar.footer.action`. Session navigation opens a Session first and closes Taskboard second, so an invalid id leaves the board visible. Run waits for Host dispatch acknowledgement before navigation. Unsaved execution inputs prevent dispatch rather than silently sending stale content; opening a linked conversation never resubmits instructions.

Session-header navigation derives its targets from current DSH task connections, including archives, rather than historical or unresolved links. A root-scoped child control and Taskboard share a one-shot selection store; the Session-scoped header does not create per-Session navigation stores. Consuming the request prevents ordinary sidebar navigation from reopening stale details. Multiple current links require a user choice.

New Task and task editing support associating an existing conversation. The Host validates Workspace membership before committing a changed selection. Create can save content and a validated connection together, preventing orphan task creation after failed link validation. Ordinary planning edits require no provider discovery.

Native terminal navigation uses Host-derived identities and registered Workspace paths. The browser supplies no executable, argv, cwd, or environment. The adapter retains fixed resume arguments and shared Win32 quoting through Windows Terminal's semicolon parser and command-line reconstruction.

**Superseded status policy:** Live Session, Goal, Job, and Subagent facts decorate cards only. They never mutate durable status. In particular, agent completion may suggest In Review but cannot silently mark a task Done. [Execution-driven columns](2026-09-09-taskboard-execution-driven-columns.md) replaces this rule for correlated Taskboard executions; unrelated live facts remain decorations.

New Task holds a local draft until Save or Save and Close succeeds. Save continues in the same centered details dialog used by card selection; Save and Close returns to the board. Cancel discards an unsaved creation without writes. Archive and Delete belong only to saved tasks. Dismissal waits for persistence so a rejected save remains visible with its draft; a delayed save completion cannot close another selected task.

Active and archived records share the controller snapshot; `archivedAt` selects the full-width Archive list instead of the active columns. Archive is an upsert, not a deletion, so refresh can recover the record and its original status. The Client retains newer task revisions against delayed echoes and baselines, while actual task or Workspace removals retain deletion tombstones. Archived details permit restore, deletion, and conversation navigation but not execution or content editing. The controller drops archived Agency observations, including delayed inspection results.

Confirmed deletion removes only the revision-checked Taskboard record. Session associations do not transfer ownership: linked DSH Sessions, existing Copilot CLI sessions, and user terminals survive task deletion. The Host serializes deletion with Agency handoffs, and the Client installs the authoritative removal only after success so delayed task echoes cannot recreate the deleted card. A rejected deletion leaves the task visible for explicit retry.

## Alternatives considered

**Embed Dashi Taskboard in an iframe.** Fast, but it requires a second HTTP service, duplicates project/session state, bypasses DSH slots and theme, and retains Codex-specific injection machinery.

**Replace Conversation.** This collapses all descendants and loses draft/view state.

**Use `shell.overlay`.** It covers the sidebar and is intended for additive floating surfaces, not application navigation.

**Use a chain overlay.** The renderer preserves React identity but hides the fallback with `display:none`; that changes measured geometry during streaming. The layout-owned keyed overlay keeps dimensions stable.

**Reuse `todo_write` or Agent Teams.** Their identity, lifetime, status vocabulary, and ownership are different. Agent Teams remains a private coordination prototype.

**Open an empty CLI or resubmit on every resume.** An empty CLI does not start the task. Resubmission may repeat completed mutations, so existing sessions remain under the user's control.

**Treat native Session creation as task execution.** Creation only provides an addressable Session. The prompt API owns input admission, user-message logging, and agent execution; Taskboard uses that API instead of reproducing the loop or inferring success from an empty Session.

**Keep archived cards only in browser state.** A page refresh would lose the Archive list. The same authoritative task feed carries active and archived records; presentation filters them without creating another business-state store.

**Persist a reverse Session-to-task index.** Current task connections already determine the targets. A second saved index can diverge after disconnect, reassociation, or deletion and is unnecessary for presentation-only navigation.

**Save a task before linking the selected CLI session.** Link validation could fail after creation, leaving a task whose saved state disagrees with the submitted form. One validated durable write keeps both outcomes together.

**Delete linked sessions with their task.** Existing sessions may predate the task or be linked elsewhere. Removing a planning record does not authorize stopping their work or erasing their history.

## Testing

Planning tests cover ordering, revision races, Workspace membership, archive, and restart. Controller and Client tests preserve baseline-first streaming, failure visibility, delayed-response protection, registration lifetime, drag/status moves, and conversation navigation. Layout and browser tests cover Conversation geometry, drafts, scroll state, portal suspension, focus, native-opening controls without real terminal launch, and Web composition.

Archive feed tests cover reopened Host projections, archived upserts, and Workspace removal. Client tests retain archives across stale updates and reconnects, discard delayed Agency observations, and separate planning status from live activity. Taskboard component tests cover unsaved cancellation, both save choices, pending and failed saves, delayed completion after task removal, bilingual Archive filters, read-only archived details, and operation feedback inside the modal.

Existing-conversation tests cover Workspace-filtered discovery, stale selections after Workspace changes, visible discovery failures, atomic creation with a connection, explicit disconnect, and reload durability. Component and assembled cases select a conversation without starting work. Session-header navigation covers current links, archived details, shared-Session task choices, deleted-task feedback, consumed requests, and unchanged execution history.

Deletion tests cover active and archived records, preserved session links outside the deleted record, revision conflicts, removal frames, delayed echoes, and reopened Host state. UI tests exercise bilingual confirmation, cancellation with retained drafts, failure and retry, and duplicate-submit prevention; the assembled scenario removes both active and archived tasks.

Execution and recovery coverage follows the [execution decision](2026-09-09-taskboard-execution-and-conversations.md#testing). The [Taskboard start scenario](../../../../snapshots/web/taskboard-start-work/) preserves the assembled Web path and borrowed genuine response stream for keyless replay.

## Consequences

The generic storage-domain CAS is authoritative only inside one Host process. SQLite gives restart durability, not cross-process compare-and-set. Querying scans the in-memory domain table and fractional rank compaction is deferred. A later collaborative deployment needs a dedicated relational provider with SQL-level CAS, indexed query, and a durable change feed.

The product flow is informed by Dashi Taskboard (<https://github.com/chuspeeism/dashi-taskboard>, Apache-2.0). No upstream source is vendored.
