# Agent Note: Personal-assistant proactive Inbox

Status: implemented

English | [中文](2026-09-21-personal-assistant-proactive-inbox.zh.md)

## Problem

A scheduled assistant can produce a saved conversation without reaching its user. A transient completion indicator disappears across reconnect, while repeating the model run to restore visibility wastes work and can contradict a user's pause. Idle alone cannot establish that a briefing succeeded.

## Decision

The existing [briefing bundle](../../../../work-assistant/packages/wa-briefing/README.md) owns its Cron timer, bounded read-only Agent, interruption policy, and durable Inbox. It uses a separate versioned domain on the profile's existing storage backend, not a second database or scheduler. Scheduling remains an explicit deployment opt-in. The [action-admission decision](../architecture/2026-09-17-personal-assistant-action-admission.md) continues to govern tools and writes.

One atomic state record stores pause, the latest attempted UTC minute, a pending Session reference, and a bounded item list. An occurrence is recorded before agent creation. Complete assistant output and successful calendar evidence are required before publication, and the Session flush precedes the Inbox write. On restart, only the pending Session is inspected: a verified completed response is published once without a model call; absent or incomplete work is not retried. A persistence read failure remains visible rather than discarding the reference.

Pause immediately aborts owned creation or generation, persists policy, removes any racing active publication, and awaits quiescence. Future admission and publication recheck the saved policy. Failed policy writes restore the latest caller's effective flag from persisted state while still joining cancelled work. Resume affects future ticks only. Count retention evicts previews, not Session logs or the occurrence watermark.

The [assistant UI](../../../../work-assistant/packages/wa-ui/README.md) reads a bounded same-origin endpoint through its own observable. Polling, reconnect, and refresh fetch existing state and never start an Agent. A sidebar unread badge survives panel collapse, and the panel header previews the latest unread response without stealing focus. Explicit Open and reply marks read and opens the ordinary conversation; no message is sent automatically. Read and dismiss state is independent of the [conversational reaction policy](2026-09-19-personal-assistant-selective-reactions.md).

The endpoint accepts only custom-header loopback requests and same-origin JSON mutations. It exposes no run-now action or model-selected destination. Unattended Agents retain plugin provenance and exact read-only tools; they cannot call interactive questions or writes. Package updates use immutable digest-named archives and an explicit setup update option, preserving profile patches, preset assets, and saved policy.

## Alternatives considered

**A prompt-only instruction or core-loop rewrite.** A prompt cannot wake an idle Agent. The published Agent follow-up API already supplies a wake, so the application owns when and why to use it.

**A generic durable task queue or another scheduler.** One configured briefing needs one pending reference and a bounded Inbox. General retry, distributed leases, and catch-up scheduling add unsupported behavior; missed and incomplete occurrences remain skipped.

**Transient toasts or rerunning on reconnect.** Neither preserves unread messages reliably. Fetching a durable Inbox separates communication state from model execution.

**Treating idle, an emoji, or a question answer as success or permission.** These facts do not prove a completed calendar-backed response or a write grant. Existing action approval remains independent.

## Consequences

The deployment supports one process per dedicated home and loopback HTTP, not remote/proxy origins. A crash can consume an occurrence before a usable response exists; there is no exactly-once execution promise. Session persistence corruption fails recovery rather than silently regenerating content. Browser push, external sends, quiet hours, calendar-change sensors, and agreed follow-ups are deferred; Cron controls the first milestone's local cadence.

The [right-panel decision](../architecture/2026-09-17-personal-assistant-right-panel.md) remains active for layout and recorded calendar/memory views. This decision adds separate durable communication state without turning those views into activity or task databases. The action-admission and receipt/question notes retain independent security and provenance rationale; none is fully superseded.

## Verification

Focused service and UI tests own occurrence deduplication, actual completion, retained unread state, recovery without model calls, pause races and failures, HTTP validation, request deadlines, and user gestures. Installed-profile coverage must use a dedicated synthetic home and preserve the normal chat/reaction regressions. Fixtures establish deterministic behavior, not real-model usefulness or delivery while the host is stopped.
