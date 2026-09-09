# Agent Note: Native Workspace Taskboard mode

Status: implemented

English | [中文](2026-09-01-native-workspace-taskboard.zh.md)

## Problem

DSH exposes durable Workspaces and Sessions plus live Goal, Job, and Subagent state, but it has no host-wide issue board. Session `todo_write` is a transient three-state model checklist and cannot represent tasks that exist before a Session, human review, stable identity, ordering, or durable project planning.

A separate Taskboard must not replace the Web shell or Conversation slot. It also cannot use a full-frame generic overlay because the standard sidebar must remain available for navigation. Unmounting Conversation would discard drafts and scroll state; hiding it with `display:none` would collapse geometry while streaming scroll observers remain live.

## Decision

Ship a native, Workspace-owned five-column Taskboard with three layers: `dsh-taskboard` owns revision-checked durable records over storage-domain; `dsh-api-taskboard-controller` exposes commands plus a reconnecting baseline-and-increment stream; `dsh-client-ui-taskboard` renders the board and Session linkage.

The Web profile mounts SQLite as a second storage backend and routes only the `taskboard` domain to it. Base profiles retain JSON as their default. Task records use stable UUIDs, Workspace identity, explicit `backlog|todo|in_progress|in_review|done` status, rank, positive revision, timestamps, optional priority and labels, an optional native DSH Session id, and an independent optional Agency Copilot CLI UUID. Archive remains orthogonal to status.

AppFrame owns a root-scoped keyed `main.surface`. Its selected id lives in the root layout store. The active entry spans the center and details grid tracks while Sidebar remains uncovered. Conversation and Details stay mounted at their original dimensions but become invisible, inert, and inaccessible. AppFrame sends `active:false` into Conversation so attachment document listeners and body-portaled draft previews dismiss rather than escape above Taskboard.

The sidebar launcher registers in `sidebar.footer.action`. Session navigation opens a Session first and closes Taskboard second, so an invalid id leaves the board visible. Starting native DSH work creates a Workspace Session, CAS-links it, moves the returned revision to In Progress, then opens it. Separately, loopback-only **Start with Copilot** makes the Host generate and CAS-link a UUID before handing fixed `agency copilot --session-id <uuid> --interactive <task>` options to Windows Terminal at the immutable Workspace path. The persisted title and description form the initial user prompt. Open/Resume scans bounded Agency JSON, avoids duplicating an `in_use` identity, and uses `--resume=<uuid>` without another prompt for observed idle state. Only a confirmed missing identity permits a fresh-launch retry with task content. The browser supplies no executable, argv, cwd, or environment; fresh launch accepts no caller-generated UUID.

New Task and task editing also support associating an existing local Copilot CLI session. The Host discovers bounded Agency rows and filters them by the canonical task Workspace path. A changed selection is checked against current Agency data before content and link commit together under revision CAS. This prevents both arbitrary cross-Workspace association and orphan task creation after a failed link. Unchanged links do not require discovery, so ordinary metadata edits remain available offline. Association is independent of execution: it never opens or resumes a terminal, resubmits instructions, changes planning status, or replaces a native DSH Session link.

Task text remains data through both Windows Terminal's semicolon parser and its command-line reconstruction. The adapter reuses the shared Win32 argument quoting and compensates for Terminal's outer quotes. Oversized command lines fail explicitly instead of truncating the task. Copilot owns the external user-message log and retains normal interactive tool approvals; DSH does not inject the task into an unrelated native Session.

Live Session, Goal, Job, and Subagent facts decorate cards only. They never mutate durable status. In particular, agent completion may suggest In Review but cannot silently mark a task Done.

Task creation and card selection open the same centered details dialog. Active and archived records share the controller snapshot; `archivedAt` selects the full-width Archive list instead of the active columns. Archive is an upsert, not a deletion, so refresh can recover the record and its original status. The Client retains newer task revisions against delayed echoes and baselines, while actual task or Workspace removals retain deletion tombstones. Archived details permit deletion and existing DSH Session navigation but not editing or Copilot launch. The controller drops archived Agency observations, including delayed inspection results.

Confirmed deletion removes only the revision-checked Taskboard record. Session associations do not transfer ownership: linked DSH Sessions, existing Copilot CLI sessions, and user terminals survive task deletion. The Host serializes deletion with Agency handoffs, and the Client installs the authoritative removal only after success so delayed task echoes cannot recreate the deleted card. A rejected deletion leaves the task visible for explicit retry.

## Alternatives considered

**Embed Dashi Taskboard in an iframe.** Fast, but it requires a second HTTP service, duplicates project/session state, bypasses DSH slots and theme, and retains Codex-specific injection machinery.

**Replace Conversation.** This collapses all descendants and loses draft/view state.

**Use `shell.overlay`.** It covers the sidebar and is intended for additive floating surfaces, not application navigation.

**Use a chain overlay.** The renderer preserves React identity but hides the fallback with `display:none`; that changes measured geometry during streaming. The layout-owned keyed overlay keeps dimensions stable.

**Reuse `todo_write` or Agent Teams.** Their identity, lifetime, status vocabulary, and ownership are different. Agent Teams remains a private coordination prototype.

**Open an empty CLI or resubmit on every resume.** An empty CLI does not start the task. Resubmission may repeat completed mutations, so existing sessions remain under the user's control.

**Use non-interactive prompt mode.** It exits after completion rather than keeping the terminal available for follow-up work.

**Keep archived cards only in browser state.** A page refresh would lose the Archive list. The same authoritative task feed carries active and archived records; presentation filters them without creating another business-state store.

**Save a task before linking the selected CLI session.** Link validation could fail after creation, leaving a task whose saved state disagrees with the submitted form. One validated durable write keeps both outcomes together.

**Delete linked sessions with their task.** Existing sessions may predate the task or be linked elsewhere. Removing a planning record does not authorize stopping their work or erasing their history.

## Testing

Domain tests cover ordering, revision races, independent DSH/Copilot links, Session membership, archive, and restart. Controller tests cover baseline-first streaming, failure mapping, bounded shell-free Agency parsing, exact Windows Terminal argv, durable-commit-before-launch ordering, and stale-upsert tombstones. Client tests cover Agency status isolation, registration lifetime, launcher states, CRUD errors, drag/status moves, and linked Session navigation. Layout and browser tests cover preserved Conversation geometry, draft/scroll state, portal suspension, focus, Copilot controls without real native launch, and Web composition.

Archive feed tests cover reopened Host projections, archived upserts, and Workspace removal. Client tests retain archives across stale updates and reconnects, discard delayed Agency observations, and separate planning status from live activity. Taskboard component tests cover automatic creation-to-details navigation, bilingual Archive filters, read-only archived details, and operation feedback inside the modal.

Existing-session association tests cover Workspace-filtered discovery, stale results after Workspace changes, explicit discovery failures and retry, atomic create/edit/clear, independent DSH linkage, and reload durability. Component and assembled fixture cases select an existing CLI session without starting one.

Deletion tests cover active and archived records, preserved session links outside the deleted record, revision conflicts, removal frames, delayed echoes, and reopened Host state. UI tests exercise bilingual confirmation, cancellation with retained drafts, failure and retry, and duplicate-submit prevention; the assembled scenario removes both active and archived tasks.

## Consequences

The generic storage-domain CAS is authoritative only inside one Host process. SQLite gives restart durability, not cross-process compare-and-set. Querying scans the in-memory domain table and fractional rank compaction is deferred. A later collaborative deployment needs a dedicated relational provider with SQL-level CAS, indexed query, and a durable change feed.

The product flow is informed by Dashi Taskboard (<https://github.com/chuspeeism/dashi-taskboard>, Apache-2.0). No upstream source is vendored.
