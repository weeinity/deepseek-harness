# Agent Note: Personal-assistant selective reactions

Status: implemented

English | [中文](2026-09-19-personal-assistant-selective-reactions.zh.md)

## Problem

An automatic thumbs-up on every admitted message describes delivery, not a conversational response. It can accompany an ordinary greeting or substantive answer unnecessarily. A personal assistant needs to choose when a small acknowledgement is sufficient and when words or useful work are required.

## Decision

The [personal-assistant preset](../../../../work-assistant/packages/wa-preset/README.md) permits an occasional standalone thumbs-up reply for thanks, acknowledgement, or a low-stakes update that needs no answer or action. It does not impose a frequency or classify messages in the browser. Greetings, questions, substantive requests, unclear messages, distress, errors, and confirmation decisions require words or useful work.

The [assistant UI](../../../../work-assistant/packages/wa-ui/README.md#acknowledgement-reactions) presents an eligible committed emoji-only reply as a chip on the exact originating Web user message instead of duplicating it in an assistant bubble. Ordinary and mixed replies remain ordinary messages. Streaming, failed, and cancelled output cannot establish a reaction. The ordinary assistant message remains the durable and model-visible record; trajectory and model history retain it.

The configured preset and display policy scope this presentation. Off preserves ordinary emoji replies, including historical ones. A reaction is neither authorization nor evidence of completed work. The shared user-badge slot, input provenance, scoped questions, and write-approval rules from the [receipt and question decision](2026-09-18-personal-assistant-receipts-and-questions.md) remain active; this decision supersedes only its automatic admission-receipt policy.

## Alternatives considered

**A receipt on every admitted message.** Admission is a useful transport fact but does not express the assistant's choice to acknowledge rather than answer. Displaying it as a conversational reaction misrepresents that choice.

**Browser keyword rules, random reactions, or a fixed cadence.** These fabricate a response independently of the model and can react inappropriately to substantive or sensitive messages. The assistant's logged reply owns the choice.

**A dedicated acknowledgement tool and custom durable event.** A standalone assistant reply already records the choice. A tool adds execution and follow-up-request machinery without a needed side effect.

**Replacing the stock renderer or mutating its DOM.** The assistant only owns its reaction presentation. Attachments, normal text, copy controls, and all other conversation rendering remain with shared Chat.

## Consequences

The model decides when to acknowledge, so prompt guidance does not guarantee a particular reaction frequency. The attached presentation recognizes only the supported standalone thumbs-up; other emoji and mixed replies remain visible as ordinary replies. The UI adds no separate model call, approval state, or acknowledgement event.

Focused tests cover normal replies without reactions, identical user text with different model responses, exact message identity, incomplete and cancelled output, preset isolation, disabled presentation, and replay. Installed-profile browser coverage also checks attached geometry, copied text, and the absence of duplicate emoji replies. These fixtures establish presentation behavior, not general model adherence.
