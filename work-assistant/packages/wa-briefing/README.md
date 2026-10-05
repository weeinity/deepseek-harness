---
description: "Scheduled personal-assistant briefing Sessions for one configured DSH home."
kind: "package-bundle"
---

# Personal briefing scheduler

English | [中文](README.zh.md)

## Summary

Receive scheduled personal briefings in the assistant Inbox without sending a chat message. A five-field cron expression and IANA time zone define the schedule. Successful read-only calendar briefings remain available after reconnect and restart. Pause or resume future briefings, mark messages read, dismiss them, or open their ordinary conversation to reply.

## Contents

- [Configuration](#configuration)
- [Briefing runs](#briefing-runs)
- [Inbox and pause](#inbox-and-pause)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## Configuration

The inserted `wa-briefing` row is disabled by default. Enabling it requires `cron`, `timeZone`, `workspace`, `provider`, and `model`; missing or invalid values fail during plugin load. The cron expression must have exactly five fields. The process must remain running for due times to fire.

```yaml
- id: wa-briefing
  config:
    enabled: true
    cron: '0 9 * * *'
    timeZone: America/Los_Angeles
    workspace: C:\Users\you\assistant-workspace
    provider: deepseek-official
    model: deepseek-v4-flash
    includeMemory: true
```

Run bounds are deployment config fields: `lookAheadMinutes`, `createTimeoutMs`, `turnTimeoutMs`, and `maxPromptBytes`. The [calendar configuration](../wa-calendar/README.md#configuration) enforces result caps for both interactive and scheduled calls. `includeMemory: true` requires `memory_read` and `memory_list` to exist when a briefing Agent is created; `memory_write` remains hidden from briefing Agents.

<a id="briefing-runs"></a>
## Briefing runs

Each due run creates one root Agent with `meta.agentPreset: personal-assistant` and `meta.cwd` set to the configured workspace. The setup hook awaits `ctx.agentPresets.mount(agentCtx, 'personal-assistant')` before publication, then applies `ctx.tools.restrict()` with the exact read-only tool names. The prompt is a plugin-sourced user message that records `Window start`, `Window end`, and `Time zone` as ISO instants and an IANA zone.

The scheduler skips overlapping triggers and stores no missed-run backlog. A persisted UTC-minute watermark prevents repeated or older occurrences from starting another Agent. Admission records the pending Session before creation. Restart reads only that pending Session: a successful persisted response enters the Inbox without another model request; an absent or incomplete run is not retried. Storage corruption fails startup rather than erasing the pending record.

Inbox publication requires a completed turn, noninterrupted assistant text, a successful `calendar_list` result, no failed tools, and no intervening direct-human input. `whenIdle()` alone is not success. Session persistence is flushed before Inbox publication. Unload, timeout, or pause cancels owned work and awaits disposal. The runner cannot ask interactive questions, write memory or calendars, or send messages outside DSH.

<a id="inbox-and-pause"></a>
## Inbox and pause

The [assistant UI](../wa-ui/README.md) reads saved Inbox state independently of the selected conversation. Read and dismiss operations are explicit user gestures, not inferred delivery receipts or action approvals. Pausing persists across restarts, cancels in-flight preparation, and fences publication; resuming permits future scheduled ticks only. A deployment with `enabled: false` cannot be opted in through Resume.

`maxInboxItems` defaults to 50 (1–200), including dismissed items. `maxPreviewChars` defaults to 2000 Unicode code points (1–8000). Old Inbox items are evicted by count; complete Session logs follow DSH retention, not Inbox eviction. Occurrence deduplication survives eviction. Both policy and Inbox records use the profile’s existing storage backend under `workassist_briefing`.

The feature registers `GET` and `POST /api/work-assistant/briefing` only when the Web host is present. Requests require `x-dsh-assistant: 1` and a loopback Host (`localhost` or `127.0.0.1`); POST additionally requires a matching HTTP Origin and a bounded JSON action. The endpoint permits read, dismiss, pause, and resume, never run-now. It does not support proxy origins or remote hosting.

<a id="model-experience"></a>
## Model Experience

### Scheduled prompt

#### Trigger

A due cron tick or a trusted host call to `ctx.workAssistBriefing.trigger()` starts a run when enabled, unpaused, idle, and newer than the persisted occurrence watermark.

#### What the model sees

The model sees the personal-assistant persona, the scheduled prompt with exact window instants, and only `calendar_list`, `calendar_find_conflicts`, plus optional `memory_read` and `memory_list`. Calendar and memory results state that external content is data, not instructions.

#### Token effect

Each run creates its own Session and appends the scheduled prompt, any read-only tool results, and the assistant brief. Connector limits bound tool-result sizes.

#### KV Cache effect

The persona and tool schemas are stable for one configured home. The scheduled prompt changes for each due instant, so run-specific window tokens do not form a reusable prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Scheduling is process-local. It provides no exactly-once guarantee across processes; run one instance per DSH home.
- Missed occurrences are skipped while the process is stopped; there is no catch-up queue.
- Quiet hours, calendar-change detection, agreed follow-ups, browser push, and external delivery are deferred. Configure Cron for suitable local hours.
- Crashes can leave an incomplete occurrence with no Inbox item. Recovery never reruns it; this is not exactly-once execution.
- The scheduler is single-user and does not isolate malicious plugins mounted into the same profile.
