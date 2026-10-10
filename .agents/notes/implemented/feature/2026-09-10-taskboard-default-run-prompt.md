# Agent Note: Taskboard default run prompts

Status: implemented

English | [中文](2026-09-10-taskboard-default-run-prompt.zh.md)

## Problem

A task's title identifies the work, while its description can contain the instructions needed to perform it. A title-only submission omits those instructions unless the user duplicates them into the separate run prompt.

## Decision

A blank run prompt resolves to the title and nonblank description, separated by a blank line. A nonblank run prompt overrides both and is preserved verbatim. Whitespace-only descriptions contribute nothing; nonblank descriptions retain their formatting.

This supersedes only the title-only default in [Taskboard executions and exclusive conversations](2026-09-09-taskboard-execution-and-conversations.md). Its execution ownership, recovery, and conversation decisions remain active.

The domain resolves the input once at durable admission for DSH, Copilot, manual runs, and scheduled runs. Frozen handover is appended afterward. Run Again uses the current saved fields; an open or historical execution and a matching request replay retain the original input. Version-1 migration retains its explicit materialized prompt, and Session logs are not rewritten.

## Alternatives considered

**Keep description as planning text only.** This requires copying execution instructions into another field and leaves a task with only a short title as its model input.

**Always append description to an explicit prompt.** This removes the user's override and can submit irrelevant or conflicting planning text.

## Testing

Domain regressions pin whitespace handling, exact overrides, handover, scheduled admission, frozen attempts, and edited same-conversation reruns. Host regressions check dispatch to both providers. The [recorded Web scenario](../../../../snapshots/web/taskboard-start-work/) checks the default and explicit override against persisted user messages while retaining its borrowed genuine recording.

## Consequences

Tasks with a blank run prompt submit their descriptions and consume the corresponding input tokens. Users who need a separate execution instruction can set the run prompt. Task edits do not alter already admitted work.
