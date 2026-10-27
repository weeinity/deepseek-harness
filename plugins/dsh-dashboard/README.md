---
description: "Configure Dashboard, reversible Personal Work attention decisions, source-specific Q&A, read-only sources, and offline exports."
kind: "package-bundle"
---

# dsh-dashboard

English | [中文](README.zh.md)

## Summary

This private bundle adds Dashboard beside Taskboard and Settings, with read-only Personal Work and Azure DevOps sources and source-specific native Q&A. Personal attention supports reversible local decisions and explicitly confirmed Q&A proposals; external records remain unchanged. The page defaults to Personal Work without selecting an ordinary Chat. Opening reuses fresh cached data. Personal attention uses focused mailbox evidence for concrete next actions; Send supplies selected evidence to the configured native model.

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

Use a Web profile from the current DSH checkout, including the native Client `ISessions.retain` / `SessionReference` API. The profile must provide native Agent/Session services, Session JSONL persistence, `workspaceRegistry`, and persistent JSON domain storage. Authenticate Agency WorkIQ/ADO connectors and the configured DSH model separately; connector access does not establish model authorization.

### Setup: install and wire the profile

From this fork's checkout, use the [portable Web setup](../README.md) to build the local dependencies and install the complete Web profile. For isolated testing, set `DSH_HOME` separately from the normal installation:

```text
pnpm run setup:web
```

The [manifest](package.json) declares a bundle whose [patch](cordis.patch.yml) inserts only the `dsh-dashboard` row. DSH's base bundle supplies the native services and defaults to persistent JSON domain storage. A customized profile must retain those services and the storage routing below; installation does not supply credentials.

The default JSON backend covers `dashboard_chat` and `dashboard_attention`. If a custom profile selects another default backend, route these domains explicitly to `json` and preserve every other domain route.

Profile patches replace whole `config` objects, not individual nested fields. This example assumes a default `json` backend. Retain your profile's actual backend and every additional route:

```yaml
- id: storage-domain
  config:
    backend: json
    routes:
      dashboard_chat: json
      dashboard_attention: json
```

The Host plugin publishes its private preset through the native preset registry before it creates Dashboard sessions. This preset selects a scoped native tool executor independently of ordinary Chat's tool executor. Only the step-admitted attention proposal tool is described to the model; no separate preset root or diagnostics companion is required.

### Host configuration reference

Configure the `dsh-dashboard` row using the [Host schema](src/host/index.ts). A config override must restate every existing field you intend to keep.

| Setting | Default | Meaning |
|---|---|---|
| `referencePath` | Unset | Optional dated local HTML briefing; not live evidence. |
| `defaultAdoSource` | Unset | Initial ADO URL/path and source selectors. |
| `timeZone` | `America/Los_Angeles` | IANA timezone for calendar display and refresh scheduling. |
| `refreshMinutes`, `refreshMinute`, `workdayStart`, `workdayEnd` | `60`, `55`, `6`, `18` | Local-clock interval, anchor minute, start hour, and exclusive end hour; start must precede end. |
| `maxCalendarPages`, `maxPersonalItems` | `5`, `35` | Calendar page bound and bounded personal collections/sections. |
| `attention.lookbackDays`, `attention.maxItems`, `attention.maxMessages` | `7`, `5`, `50` | Recent evidence window, action-list cap and maximum messages per focused mailbox query. |
| `maxAdoItems`, `adoPageSize` | `5000`, `1000` | ADO retrieval and page bounds. |
| `staleDays`, `blockedTags` | `7`, `['blocked']` | ADO risk-flag criteria, not proof of inactivity or delay. |
| `adoAnalytics.ageBands` | `[7, 14, 30]` | Increasing day thresholds for unfinished work-item and current-state age; unknown dates remain separate. |
| `adoAnalytics.historyDays`, `adoAnalytics.maxHistoryDays` | `30`, `120` | Recent-history window and calendar-day cap; the window must not exceed the cap. |
| `adoAnalytics.maxHistoryItems`, `adoAnalytics.maxRevisionsPerItem` | `200`, `1000` | Selected-type cohort and per-item revision bounds; oversized cohorts are refused, not sampled. |
| `adoAnalytics.revisionPageSize`, `adoAnalytics.historyConcurrency` | `50`, `4` | Revision page size (at most 200) and concurrent history reads. |
| `adoAnalytics.historyTimeoutMs`, `adoAnalytics.maxHistoryRequests` | `120000`, `400` | Overall history deadline and shared request budget; omissions remain explicit. |
| `cacheSeconds`, `cacheEntries` | `600`, `8` | Automatic source-read freshness window (10 minutes) and Host cache entry bound. |
| `chatSnapshotEntries` | `16` | Maximum Host-retained immutable snapshots. |
| `chatSnapshotRetentionMinutes` | `240` | Snapshot-receipt lifetime; not history retention. |
| `maxChatContextBytes` | `128000` | UTF-8 limit for captured evidence, including its emitted wrapper. |
| `maxChatQuestionChars` | `4000` | Maximum question length; HTTP requests also have a 32 KiB byte limit. |
| `maxChatOutputTokens` | `8192` | Native model output-token limit. |
| `chatLockDirectory` | `dshHomePath('locks', 'dashboard')` | Absolute directory for exclusive Host writer ownership. |
| `chatWorkingDirectory` | `dshHomePath('dashboards', 'workspace')` | Absolute dedicated working directory recorded in native Session headers. |
| `workiq`, `ado` | `agency mcp workiq`, `agency mcp ado`; `timeoutMs: 60000` | Connector `command`, `args`, and timeout settings. |

The Host creates and resolves the dedicated working directory with `realpath` before use. New Session headers record that canonical directory. Keep its canonical target stable for existing histories: missing or foreign `cwd`, an incompatible preset, or parent/origin/seed lineage rejects reopening. The runtime does not rewrite or migrate existing headers, and it does not replace missing history with a new identity.

A preset that cannot resolve, inaccessible storage or working directory, or conflicting writer ownership prevents Host initialization.

### Browse and ask

Open **Dashboard** in the global sidebar. Use **Personal Work** for calendar, correspondence, and dated briefing cards; use **Azure DevOps** for a supported sprint/saved-query URL or an iteration/area path with organization and project selectors. Source and work-item links remain clickable. Cached content appears immediately when returning to Dashboard or reloading the same browser tab. Automatic reads skip snapshots younger than `cacheSeconds`; expired snapshots remain visible during background refresh and after failures. The circular **Refresh now** button bypasses freshness, spins while loading, and disables duplicate clicks. The original source timestamp determines freshness, so reopening never extends the TTL. The tab stores only its last Personal and ADO snapshot in session storage, not chat or pending operations. Closing the tab clears that display cache. Storage failure falls back to in-memory reuse. After a Host restart, expired or unavailable evidence receipts require Refresh before Q&A or adjustments.

The compact header, separate tab row, cards, and collapsible Q&A rail follow the existing application theme. Dashboard-scoped colors and an embedded Inter font do not replace styles in Chat, Taskboard, Settings, or the shared sidebar. No font or chart CDN is required.

Every Personal Work tile has a qualifier. “Needs attention now” uses focused recent-mail searches, including read and moved mail, instead of the saved HTML attention list. It admits explicit personal incident assignments/mentions, direct customer requests, publication blockers and verification of your own ECS changes. Each row gives a concrete next action, why it is relevant to you, an excerpt and the original dated message link. Duplicate incident/rollout notifications collapse, loaded later replies/closures suppress older asks, and priority recommendations never become invented deadlines or live-state claims. Searches are bounded and may miss replies or obligations; verify the source before acting. Empty or unavailable current attention never revives old saved tasks. Other saved sections remain dated reference statements; calendar readings and unknown totals retain their existing meaning.

**All**, **Past due**, and **This weekend** filter only attention rows. Graph counts and stat tiles describe the full source snapshot; other sections remain unchanged. Reference classifications use the saved briefing date, not today's task status. Unclassified rows stay in All. If classifications are unavailable, the page explicitly shows All; question context and exports use that same displayed selection.

### Adjust Personal attention

Use **Hide**, **Mark handled**, or **Snooze** beside an attention item. These decisions remove the item from your attention view, not from its source. Mark handled records your decision; it does not verify completion or close a work item. The attention summary separates visible, hidden, handled, and snoozed loaded items from the original source population; unknown source totals remain unknown.

**Review local decisions** exposes excluded items and decisions whose items are absent from the loaded briefing. **Restore attention** removes an exclusion. **Undo** restores the previous decision, including a prior snooze deadline, rather than always showing the item. Undo is available only for an item's latest undoable action; a later change refuses an older Undo. Absent items support Restore only.

Snooze requires a future minute in the displayed Dashboard timezone. Nonexistent and repeated local minutes require a different selection. Expiry re-evaluates the local view without a source or model request. Refresh, briefing reordering, and Host restart preserve saved decisions. Identity uses source kind, canonical safe URL, and normalized case-sensitive title; changed URLs or titles require a new decision rather than fuzzy matching. Changed detail or severity resurfaces an item for review; ambiguous identities remain visible and cannot be adjusted.

Ask Personal Q&A to propose one specific item adjustment. A confirmation card shows the item, action, deadline when applicable, and current status. **Apply local change** persists the exact proposal; **Cancel** rejects it without changing the item. The model stages at most one proposal per question and does not apply it. Excluded captured items support Restore proposals; use the review controls for absent decisions. Expired or stale proposals require a fresh question, not an automatic retry against new evidence.

If acknowledgement is uncertain, **Retry captured operation** retains the original operation and request ID. **Reload local adjustments** refreshes the display but does not resolve that uncertainty or enable another write/question. A confirmed change updates the displayed snapshot and receipt together; subsequent questions and exports use the effective attention selection, while earlier questions retain their original evidence. Local controls and confirmation do not call a model.

### ADO delivery analysis

Select one work-item type to inspect completion, remaining work, risk flags, age, areas, and current ownership. Only `Completed` is complete; `Resolved` remains unfinished. `Unknown` and `Removed` stay visible but do not enter progress, people, risk, or estimate totals. Partial sources show loaded-only counts. Estimate fields remain separate and do not imply hours.

The closure path assigns each unfinished eligible item once, in this order: blocked, unassigned, overdue, resolved, stale, continue. Risk bars overlap and show a distinct-item union separately. Predecessor groups describe current open, unavailable, or clear observations; a relation is not proof that work is actually blocked.

Age bands use genuine CreatedDate and StateChangeDate at snapshot time. Missing or future dates remain unknown; ChangedDate does not substitute for state age. Area and current-assignee charts retain all state categories. Assignee rows show eligible completed/unfinished counts in alphabetical order, not authorship, productivity, performance, or capacity.

**Load current-cohort history** explicitly reads revisions for the currently loaded items of the selected type, bounded by each captured revision. Current cards do not wait for history. The history view shows completion occupancy, state-category occupancy, and distinct-daily completion/reopening events for that current cohort. A single item can complete and reopen on the same day; each event kind counts it once.

Sources without an iteration use the configured recent-history window. Sprint sources require valid start and finish calendar dates; missing, invalid, reversed, or not-yet-started ranges leave history unavailable rather than substituting recent dates. The range uses the configured timezone, stops at the snapshot time, and respects the configured day cap. Every history chart names its dates, date source, timezone, fetch time, and coverage. Omitted histories are not zero observations; unavailable history produces no lines. Bounds, provider failures, and the overall deadline can leave partial or unavailable history without removing current cards.

History cannot reconstruct items removed from the sprint, historical team-area configuration, or historical board columns. It is not a full-sprint burnup/burndown, a board cumulative-flow diagram, or a capacity forecast. Successful history enrichment receives a new retained snapshot receipt; prior questions retain their original evidence. Loading history neither sends a model request nor changes the source's draft/history identity.

### Snapshot questions and selection

The right-hand **Snapshot Q&A** panel opens one Personal Work history and one history per normalized ADO source. ADO identity includes organization, project, optional team, mode, resolved query/iteration/area selector, and child-path choice. URL aliases and case normalize; filters, sorting, pagination, and selected detail do not create another history. Switching sources or opening history does not replace the ordinary Chat selection.

Suggestion chips fill the draft without submitting it. **New question** focuses the composer without clearing a draft or history. The model label is read-only; the panel does not expose model switching or slash commands. **Copy answer** reports clipboard success or failure.

Before Send, review the displayed context and disclosure. The Host uses the immutable snapshot retained with that display and the selection captured for the question, including capture/fetch timestamps, source dates, stale state, and completeness warnings. A later refresh cannot substitute newer data for that question.

ADO counts deliberately use different selections:

| Display | Selection |
|---|---|
| KPI, estimate totals, delivery, closure, risk, age, area, predecessor, and history charts | Type, person, state, tag, and text; not metric, risk, or chart-drill filters. |
| Actual-state chart; person chart without analytics metadata | Every returned item of the selected type, regardless of the other filters. |
| Current assignee ownership | Every returned item of the selected type, in alphabetical order; not a productivity ranking. |
| Table and question matching rows | Every active filter, across all pages. |

A refresh can leave a selected area with no matching rows. An existing age selection retains its numeric interval even if configured chart bands change. Neither case widens the table selection or narrows the base chart scope.

Question evidence includes those distinct totals/charts, all matching rows, the visible page/sort information, and the selected item's detail. It is not limited to the current table page. Expired or evicted snapshot receipts reject until an explicit refresh; oversized context rejects until filters are narrowed or the configured limit is increased. Neither failure silently substitutes data or truncates matching rows.

ADO presentation, export, and Q&A share the same report calculations. Export captures that report before narrowing the matching table, so filtered rows cannot replace full-type owner counts or base-scope chart denominators. Q&A accepts only Host-retained evidence; a browser-supplied export report is not trusted.

Drafts, errors, and retry captures are source-local within the mounted Client. An accepted send clears only its captured draft revision; acceptance confirms queueing, not a completed answer. **Retry captured question** preserves the original request ID, question, source, snapshot, and selection. The Host reconciles accepted receipts durably before applying snapshot expiry or current deployment limits. An interrupted admission remains uncertain: inspect native history and reconcile the captured request rather than blindly submitting a new question.

**Stop** cancels only the selected source's native Session. Source/page navigation and release of a native read lease do not cancel admitted model work. Source-read cancellation is separate from model cancellation.

Dashboard histories and submitted evidence persist in native Session JSONL; the `dashboard_chat` JSON domain persists source mappings and admission receipts. Workspace archiving suppresses these Sessions from the ordinary workspace list, but is not access control: native APIs and local logs can still expose them. Per-source isolation and the dedicated working directory do not provide confidentiality from those readers. Stored per-chat opt-in settings are left untouched and are not consumed for page visibility or history.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The [Host](src/host/index.ts) owns lazy, read-only [MCP SDK clients and Agency subprocesses](src/host/mcp.ts). It registers seven fixed authenticated POST routes under `/api/dsh-dashboard/`: `settings`, `snapshot`, `ado-history`, `chat-open`, `chat-send`, `attention-read`, and `attention-write`. DSH Connection owns authentication and origin checks. The Host validates requests; the Client validates snapshots, proposals, and durable acknowledgements.

`ado-history` accepts a retained `snapshotId`, selected `type`, and optional `force`. The read-only connector allowlist includes `wit_work_item/list_revisions`; callers cannot choose other connector operations. The [history loader](src/host/ado-history.ts) retains bounded category observations under snapshot revision fences, not unrestricted revision bodies. The [shared report](src/shared/ado-analytics.ts) derives chart groups and drill membership; the [export-only projection](src/shared/export-types.ts) retains the report without extending accepted question evidence.

The [insight builder](src/host/personal-insights.ts) keeps interpretations separate from measurements. [Attention selection](src/shared/personal-selection.ts) supplies the same ranked rows to presentation, export, and captured evidence while preserving source-wide counts. Local-clock [refresh slots](src/shared/schedule.ts) are independent of fetch completion.

The [attention journal](src/host/attention-store.ts) records each decision and its idempotency/Undo receipt atomically in `dashboard_attention`. Its native single-document JSON layout refuses malformed or incompatible storage rather than skipping records. Source caching remains separate from [effective-view publication](src/host/attention-views.ts); cache hits and completed source reads apply the latest decisions. Full-operation single-flight preserves duplicate-request identity through lookup, validation, persistence, and publication. A publication failure after commit remains uncertain, never a proven rejection.

The [chat runtime](src/host/chat/index.ts) owns native Agent creation/resumption, exclusive writer ownership, and the [durable identity/receipt domain](src/host/chat/domain.ts). Native Session logs and projections own history, streaming, paging, and cancellation; the Client reads them through retained leases rather than a second conversation store. Host-retained [snapshot contexts](src/host/snapshot-context.ts) are bounded in memory and separate from both source caching and durable history.

The [analysis preset policy](src/host/chat/preset-policy.ts) admits only Host-approved questions. ADO has no tools. Personal Work receives only the Agent-bound proposal capability for identities in its immutable admitted evidence; inherited, unrelated, nested, and unapproved tool calls remain denied. A queued receipt is not a completion record.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

See the owning files for configuration, captured evidence, admission, and export details:

[Bundle layer](cordis.patch.yml) · [Analysis preset](src/host/chat/presets/dashboard-analysis/preset.yml) · [Source request schemas](src/shared/requests.ts) · [Question selection](src/host/snapshot-context.ts) · [Retry admission](src/host/questions.ts) · [Export renderer](src/export/html.ts) · [Current-cohort history](src/host/ado-history.ts)

[Attention persistence](src/host/attention-store.ts) and [confirmation requests](src/shared/attention.ts) define identity, journal durability, and the separation between proposals and user authorization.

The chart labels distinguish this current-cohort evidence from [Azure Boards cumulative flow](https://learn.microsoft.com/en-us/azure/devops/report/dashboards/cumulative-flow?view=azure-devops), which describes board-column counts. Complete adjacent data tables and text labels follow [W3C guidance for complex images](https://www.w3.org/WAI/tutorials/images/complex/); color is not the only way to read a value.

-----

<a id="model-experience"></a>
## Model Experience

### Dashboard analysis

#### What the model sees

Send supplies the human question, captured evidence, source-specific native history, and the appropriate fixed [persona](src/host/chat/capture.ts). The ADO analysis persona begins:

```text
You answer questions about the supplied Dashboard snapshots.
```

Both personas treat titles, descriptions, messages, links, and imported briefings as untrusted evidence, not instructions. The Host logs admitted question/context messages and checkpoints model-visible history before streaming. It uses the configured native model route without substitution. Personal evidence includes local decisions and a bounded proposal-only tool; its logged result and confirmation card never imply source completion. The model cannot apply adjustments, execute general tools, or write through connectors.

The Q&A panel renders human messages and streaming answers as plain text. Final answers use memoized, restricted Markdown: raw HTML is not interpreted, model-authored links remain text, and images render only their alternative text. No embedded or remote resources load. Dashboard source links are separate and remain clickable.

#### Token effect

Opening, refreshing and reading history make no model request. Focused mailbox queries use WorkIQ fetch only. Each Send adds question and evidence tokens to the source's native history. The evidence byte limit is not a whole-conversation token limit; provider context limits still apply.

#### KV Cache effect

Each question appends captured evidence to its source-specific history. Cache reuse depends on the configured provider and retained request prefix; this package does not guarantee unchanged cache behavior or a cache hit.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits apply to the evidence and its presentation, including model answers based on it.

- Reference HTML supplies dated plain text and safe source links, not live measurements. Import removes active markup, omits items without safe links, and reports missing dates or bounded sections. Live refresh does not revalidate imported claims.
- Personal collections can be partial. Inbox unread counts are not all-mail counts; Teams unread totals remain unknown without complete evidence. Reply candidates are heuristic and may already have replies. Out-of-office counts describe notices, not distinct people; recent files are bounded OneDrive root children, not all Microsoft 365 files.
- Adjustments belong to this Host/profile's Personal attention, not to an authenticated-user partition or a topic-wide rule. They do not personalize ADO or mine ordinary Chat. The journal retains decisions, target labels/URLs, and receipts; low-frequency edits rewrite the whole document. Review and source-side verification remain human responsibilities.
- ADO history covers only the currently loaded selected-type cohort, not complete historical sprint membership. Current state categories do not reconstruct historical process or board configuration. Partial results describe only returned records; an old changed date does not prove inactivity.
- ADO accepts supported Azure Boards URLs or explicit selectors, not arbitrary URL fetches or user-supplied WIQL. Team-scoped area reads are unsupported. Team sprints require one exact iteration without child paths; project-wide iteration/area paths can include children.
- Scheduled refresh runs only while the selected Dashboard page is visible. Defaults are weekdays at :55, from 06:55 through 17:55 in the configured timezone. Custom intervals anchor at `workdayStart:refreshMinute` and stop before `workdayEnd`; missed or nonexistent local-clock slots are not replayed. Opening or returning to a view refreshes only expired or missing snapshots, including outside that window. Manual Refresh always bypasses the TTL. Hiding the page/browser pauses source reads and timers, not admitted model work. No scheduler service or email delivery exists.
- Offline HTML has English-only presentation and contains dashboard data, not Q&A history. Personal exports retain source-wide attention counts and readings while filtering attention rows only. ADO exports retain the displayed report scopes, all graph data tables, source details, and explicitly loaded history; matching rows apply every selected filter across all pages. ADO files contain no scripts and support a CSS-only dark-mode switch. Files show final values without JavaScript and load without external assets or refresh requests; clicking a source link opens the external source.

The bundled Inter font uses the SIL Open Font License; the build includes its notice at `lib\licenses\inter-OFL.txt`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Non-authoritative notes</summary>

None.

</details>
