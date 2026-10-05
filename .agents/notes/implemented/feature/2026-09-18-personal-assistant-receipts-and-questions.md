# Agent Note: Personal-assistant receipts and questions

Status: implemented

English | [中文](2026-09-18-personal-assistant-receipts-and-questions.zh.md)

## Problem

A personal assistant needs to distinguish receiving a request from agreeing, obtaining permission, and completing an action. Optimistic input and queued work do not prove processing admission. A user-role message can also contain a delegated task or injected context, so its role alone does not identify direct human input.

## Decision

The automatic admission-receipt policy below is superseded by [assistant-chosen reactions](2026-09-19-personal-assistant-selective-reactions.md). This note remains active for the shared badge slot, direct-input provenance, scoped questions, and independent write approval.

Shared Chat owns one additive, empty-by-default `conversation.chat.user-badges` slot beside its admitted user and steering rows. Its owner supplies the canonical message identity and verified Web-prompt request provenance, not message text. The [assistant UI](../../../../work-assistant/packages/wa-ui/README.md) contributes a passive receipt only when the Session's resolved preset matches its explicit display policy and that provenance exists.

The badge means receipt, not understanding, authorization, or success. Thumbs-up, neutral text, and off are deployment choices; the client does not classify emotional context before the model reads the request. History reconstructs the same presentation from admitted records without a receipt event, model call, acknowledgement store, or replay announcement. Later failures do not revoke the fact of admission.

The [personal-assistant preset](../../../../work-assistant/packages/wa-preset/README.md) owns proactive, concise guidance and mounts the existing human-question tool in its Agent scope. The [gateway](../../../../work-assistant/packages/wa-gateway/README.md) admits the exact interaction definition, not any tool sharing its name. A question answer cannot supply a connector write grant. Connector arguments are captured for audit and dispatch, and new direct-human input invalidates a pending write review in that live Agent.

The available calendar connector is read-only. The assistant can inspect its configured calendar and draft invitation text, but has no directory lookup, other attendees' free/busy service, invitation sender, reminder writer, or provider reconciliation. No speculative calendar adapter or operation ledger is added. Memory writes retain fresh one-time approval, expected revisions, and the exclusive writer lock.

## Alternatives considered

**A prompt-only emoji or acknowledgement tool.** Prompt text cannot decorate an existing user bubble. A tool or separate model reply costs a request or transcript output without establishing an earlier admission fact.

**A receipt on submit, queue insertion, or Agent idle.** These states respectively precede admission or describe an interval rather than a specific input. None proves that the exact user message entered processing.

**A receipt on every user-role row.** Delegation and injected context can use that role. Requiring trusted Web ingress provenance deliberately excludes unsupported legacy and non-Web origins.

**Replacing private message renderers or modifying their DOM.** Those approaches take ownership of attachments, copy controls, scrolling, and other unrelated presentation. An additive slot retains the shared renderer's ownership and default behavior.

**Treating a question answer as approval or adding a meeting framework without a provider.** The existing approval service owns write grants. The calendar source cannot send invitations; a fictitious executor would misrepresent capability and introduce untestable recovery promises.

## Consequences

Receipts require the shared Chat extension; the unpatched published runtime cannot display them. Leaving the contribution off preserves its existing presentation. Disabling receipts also hides historical badges without deleting or rewriting Session records.

Preset updates affect newly composed Agents, not an already-running Agent's instructions. Disabling guidance or the receipt does not undo a completed memory write. Existing audit and Git records remain available; uncertain outcomes are not automatically replayed.

Gateway and interaction tests cover exact tool admission, cancellation, and approval separation. Current presentation coverage belongs to the selective-reaction decision. Deterministic fixtures do not establish live calendar-provider behavior or deployed-model adherence rates.

The [right-panel decision](../architecture/2026-09-17-personal-assistant-right-panel.md), [action-admission decision](../architecture/2026-09-17-personal-assistant-action-admission.md), and [canonical-feedback decision](../architecture/2026-09-05-canonical-feedback-log.md) remain active. A receipt is neither another activity database nor user feedback about an assistant response.
