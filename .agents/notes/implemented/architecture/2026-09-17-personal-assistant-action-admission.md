# Agent Note: Personal-assistant action admission

Status: implemented

English | [中文](2026-09-17-personal-assistant-action-admission.zh.md)

## Problem

A personal assistant reads untrusted calendar content and retains context across conversations. Instructions alone cannot prevent that content from requesting unrelated tools or bypassing a write approval. A small plugin deployment also needs durable action attribution without duplicating DSH's permission or Session machinery.

## Decision

The independent `work-assistant` workspace consumes pinned published DSH packages. Its [gateway bundle](../../../../work-assistant/packages/wa-gateway/README.md) owns connector admission without modifying the agent loop. Deployment requires a dedicated personal DSH home and excludes generic execution, filesystem, browser, and arbitrary network tools.

A connector registers an exact tool definition and fixed action classification. The gateway uses the [monotonic tool guard](../feature/2026-06-30-interception-extension-points.md) to compare the definition visible to the calling agent with its owned wrapper. A matching name is insufficient because an agent-scoped tool can shadow a global registration.

Reads are admitted; every write requires a fresh grant from the existing [one-time approval service](../feature/2026-07-06-approval-seam.md). Deployment configuration supplies the owner identity, and DSH's execution context supplies the Session and call identities. Model arguments cannot replace these identities or select a policy. External-content exposure is audit metadata, never permission to omit approval.

The [scoped human-question contribution](../feature/2026-09-18-personal-assistant-receipts-and-questions.md) admits the exact built-in interaction definition separately from connector dispatch. Its answers remain ordinary Session tool results, not write grants or duplicate connector audit bodies. A pending write review uses captured arguments and is invalidated by new direct-human input in the same live Agent.

The gateway persists admission in a versioned DSH storage domain before dispatch. Records contain attribution, an argument digest, the decision, and the dispatch outcome; the Session log owns model-visible argument and result bodies. Interrupted records are marked on restart, not replayed. A failure after dispatch does not establish that no side effect occurred.

Credential references are resolved at use by trusted connector code. They keep a configured feed credential out of model arguments but do not isolate credentials from other plugins in the same process. Plugins, configuration, and the operating-system account remain trusted.

The [memory bundle](../../../../work-assistant/packages/wa-memory/README.md) couples each approved, revision-checked note replacement to a local commit of that note. Mutable memory reaches the model as tool-result data, not system instructions. Session lifetime is not the write transaction: a Session can span many turns and process launches.

The opt-in [briefing bundle](../../../../work-assistant/packages/wa-briefing/README.md) uses a maintained cron timer to create read-only DSH Agents. DSH Sessions retain their prompts and results. The timer is process-local and missed occurrences are skipped. The [proactive Inbox decision](../feature/2026-09-21-personal-assistant-proactive-inbox.md) owns persisted pause, occurrence deduplication, and response delivery.

## Alternatives considered

**A helper that connectors may bypass.** A model-visible tool could avoid the helper entirely. Exact registered-definition admission makes connector registration part of the execution policy rather than a naming convention.

**A second approval database with session or perpetual grants.** Persistent grants require independently designed scope, revocation, and expiry semantics. One-time DSH approvals satisfy this deployment without creating a second permission system.

**Raw arguments and results in the action audit.** DSH already records model-visible bodies in the Session. Duplicating them increases sensitive-data copies and introduces another retention policy; the action audit keeps metadata instead.

**Credential indirection as a plugin sandbox.** Trusted in-process code can reach the same services and environment. Process/container isolation and restricted profile composition remain necessary; a reference cannot provide that isolation.

**A Session-end Git sweep.** A broad commit can include unrelated edits, and shutdown is not a reliable statement of which note the user authorized. Committing each approved note keeps the write and its history attributable to one action.

**Depending on local Taskboard source.** Taskboard is absent from the published DSH release consumed by this workspace. Depending on the local implementation would couple deployment to unpublished core changes. A small cron consumer uses the public Agent APIs without adding a second durable jobs database.

## Consequences

Each connector tool must register through the gateway; the scoped question tool requires exact interaction admission. Arbitrary coding tools and corporate MCP connectors are not automatically available, and unattended writes without an approval answerer fail closed.

The [gateway tests](../../../../work-assistant/packages/wa-gateway/tests/gateway.spec.ts) exercise the real registry, approval service, and SQLite-backed domain, including scoped shadows, caller attribution, cancellation, storage failure, restart persistence, and independent audit snapshots. This evidence does not establish real-account or container operation.

The existing scope, interception, and approval decisions remain authoritative for DSH itself. The assistant adds deployment policy, not a replacement for those mechanisms or a compatibility promise across DSH preview releases.
