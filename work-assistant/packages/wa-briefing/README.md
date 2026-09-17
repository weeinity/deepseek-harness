---
description: "Scheduled personal-assistant briefing Sessions for one configured DSH home."
kind: "package-bundle"
---

# Personal briefing scheduler

English | [中文](README.zh.md)

## Summary

Create normal DSH Sessions for scheduled personal briefings. A five-field cron expression and IANA time zone define due instants while an elapsed look-ahead window defines the calendar query range. Each run mounts the `personal-assistant` preset, restricts model-visible tools to configured read-only calendar and memory names, waits for the Agent to become idle, flushes Session persistence, and disposes the owned Agent.

## Contents

- [Configuration](#configuration)
- [Briefing runs](#briefing-runs)
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

The scheduler skips overlapping triggers and stores no backlog. It does not retry failed tool calls, mutate memory, write calendars, send notifications, or deliver mail. On unload or timeout it cancels the owned Agent, waits for idle convergence, flushes the Session, and disposes the handle.

<a id="model-experience"></a>
## Model Experience

### Scheduled prompt

#### Trigger

A due cron tick or a host call to `ctx.workAssistBriefing.trigger()` starts a run when the scheduler is enabled and idle.

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
- Notifications, mail sending, calendar writes, and memory mutation are outside briefing runs.
- The scheduler is single-user and does not isolate malicious plugins mounted into the same profile.
