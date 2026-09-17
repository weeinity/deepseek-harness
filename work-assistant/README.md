---
description: "Build and run a single-user DeepSeek Harness personal assistant profile."
kind: "package-group"
---

# DeepSeek work assistant

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

This workspace builds a plugin-based personal assistant profile on published `@deepseek-ai/dsh@0.1.5-alpha.2`. It adds admitted personal calendar, memory, preset, gateway, and scheduled briefing bundles under `work-assistant`; the parent checkout owns the companion Agent Note.

<a id="contents"></a>
## Contents

- [Prerequisites](#prerequisites)
- [Packages](#packages)
- [Build and test](#build-and-test)
- [Configure a new dedicated profile](#configure-a-new-dedicated-profile)
- [Docker](#docker)
- [Limits](#limits)

<a id="prerequisites"></a>
## Prerequisites

Use Node 24, pnpm 11.7, Git, a new dedicated `DSH_HOME`, a dedicated workspace, a personal calendar `.ics` file or DSH credential reference, a local Git memory repo, and real DSH model credentials. Do not point setup at an existing user or corporate home, and do not copy old credentials into it.

<a id="packages"></a>
## Packages

- [`@deepseek-ai/dsh-wa-gateway`](packages/wa-gateway/README.md): admits only gateway-owned tools, asks once for writes, and stores metadata-only audit records.
- [`@deepseek-ai/dsh-wa-calendar`](packages/wa-calendar/README.md): reads one configured local `.ics` file or credential-backed HTTPS iCalendar feed.
- [`@deepseek-ai/dsh-wa-memory`](packages/wa-memory/README.md): stores approved Markdown notes in one dedicated local Git repository.
- [`@deepseek-ai/dsh-wa-preset`](packages/wa-preset/README.md): ships the `personal-assistant` persona assets.
- [`@deepseek-ai/dsh-wa-briefing`](packages/wa-briefing/README.md): optionally starts scheduled read-only briefing Sessions.

<a id="build-and-test"></a>
## Build and test

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:profile
```

<a id="configure-a-new-dedicated-profile"></a>
## Configure a new dedicated profile

The setup script rejects conflicting profiles and writes only the supplied calendar reference, memory root, model route, preset assets, and profile files. It accepts one package-manager separator after `pnpm run setup:profile` and rejects unknown, duplicate, or incompatible options.

```powershell
$assistantHome = 'C:\dsh-personal-home'
$assistantWorkspace = 'C:\dsh-personal-workspace'
$assistantMemory = Join-Path $assistantWorkspace 'memory'
$assistantCalendar = Join-Path $assistantWorkspace 'calendar.ics'
New-Item -ItemType Directory -Force $assistantWorkspace, $assistantMemory | Out-Null
# Place your exported personal .ics file at $assistantCalendar before setup.
git -C $assistantMemory init -b main
git -C $assistantMemory -c commit.gpgSign=false -c user.name='Personal Assistant' -c user.email='assistant@example.invalid' commit --allow-empty --no-verify -m 'initial memory root'
pnpm run setup:profile -- --home $assistantHome --profile personal-assistant --workspace $assistantWorkspace --owner-id personal --calendar-file $assistantCalendar --memory-root $assistantMemory --provider deepseek-official --model deepseek-v4-flash --time-zone America/Los_Angeles
$env:DSH_HOME = $assistantHome
.\node_modules\.bin\dsh.cmd --profile personal-assistant --no-open --host 127.0.0.1 --port 3081
```

Use `--calendar-feed-credential-ref <ref>` instead of `--calendar-file` when the calendar source is an HTTPS feed stored in DSH credentials. Add `--enable-schedule --cron '0 9 * * *'` only when you want the local process to run scheduled briefings; the default is off. For a synthetic fixture, add `--demo-fixture`; generated events are demos, not the user's agenda.

<a id="docker"></a>
## Docker

Docker is optional and was not available for verification on this host. The checked artifacts use Node 24, run as UID 10001, mount only the dedicated DSH home and workspace, store memory at `/workspace/memory`, read the local calendar at `/workspace/calendar.ics`, drop Linux capabilities, and publish the Web UI through Compose on host `127.0.0.1:3081` to container port `3080`.

```powershell
New-Item -ItemType Directory -Force .\data\dsh-home, .\workspace | Out-Null
# Put calendar.ics in .\workspace and ensure .\data\dsh-home plus .\workspace are writable by container UID 10001.
$env:WA_PROVIDER = 'deepseek-official'
$env:WA_MODEL = 'deepseek-v4-flash'
$env:WA_TIME_ZONE = 'America/Los_Angeles'
docker compose -f deployment\compose.yaml up --build
```

On persistent home restart, the entrypoint reuses the managed profile only when the stored setup inputs match. A writable workspace volume lets the non-root process create `/workspace/memory`; if the host denies writes to UID 10001, fix the mount ownership or use Docker-managed volumes before starting the container.

<a id="limits"></a>
## Limits

This assistant is for one user's personal data. It does not write calendars, send mail, notify outside DSH, support multitenancy, isolate malicious plugins in the same profile, or work without real DSH model credentials. Scheduled runs are process-local, skip missed occurrences, and provide no exactly-once guarantee across processes.
