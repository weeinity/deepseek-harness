# Agent Note: Personal-assistant right panel

Status: implemented

English | [中文](2026-09-17-personal-assistant-right-panel.zh.md)

## Problem

The personal-assistant profile needs an identity and activity view beside the conversation, including before the first message. A second activity database or a task-like list inferred from idle Agents would misrepresent what the assistant has done. Changing the shared Web application would also affect unrelated coding profiles.

## Decision

The [wa-ui bundle](../../../../work-assistant/packages/wa-ui/README.md) replaces the published Web client's root-scoped `rightbar` presentation only in profiles that install it. The normal conversation, composer, and left navigation remain owned by DSH. The panel reports its presentation through the existing layout service so the frame reserves space rather than placing a desktop overlay over the composer.

Timeline derives recent nonblank personal-assistant conversations from the Session list. Queue exposes pending interactions and running conversations without granting approval. Day and Memory project versioned tool-result presentation metadata from the selected Session's loaded chat window; neither view claims live external state. A root-owned observable connects the strict Session bridge to the root rightbar without mounting one StoreDefinition in both scopes. The bundle does not scan other Sessions, create another activity database, or interpret an idle Agent as a completed task. Connection copy identifies DSH transport connectivity, not Copilot authentication or calendar availability.

Calendar and memory tools persist their validated result values as versioned presentation metadata through the existing tool-result log. Memory write receipts are not note content, and a failed write invalidates earlier previews because file replacement can precede a Git failure. Partial lists preserve unlisted notes; they do not establish deletion.

Locale dictionaries own the panel's product copy. Nocturne token overrides respect the saved theme preference, and DSH owns sidebar navigation and rightbar sizing. Slot registrations, styles, and viewing state follow the Client plugin lifetime. Copyable calendar and memory suggestions leave navigation and drafts untouched; only an explicit paste and send produces normal logged user input. The Host entry adds no tools, prompt contributions, persistence, or account operations; the [assistant admission policy](2026-09-17-personal-assistant-action-admission.md) remains unchanged.

## Alternatives considered

**An Assistant tab in the stock docking panel.** That preserves the existing document viewers, but the tab requires a Session and starts inside a collapsed per-Session panel. It does not provide the requested assistant identity on the new-conversation screen.

**A desktop overlay or a copied application shell.** An overlay obscures the existing composer, while copying the shell makes the assistant maintain DSH navigation and rendering machinery. The root rightbar is an existing replacement point that leaves those owners intact.

**A separate activity database or manufactured task outcomes.** Session summaries already provide real conversation titles, update times, and navigation identities. A second record would duplicate data and need independent completion semantics.

## Consequences

The assistant panel replaces the stock file/resource docking presentation in its profile. It does not claim to preserve those preview destinations. Other profiles retain their own layout, and the assistant's calendar and memory permissions do not change.

The [component tests](../../../../work-assistant/packages/wa-ui/tests) cover presentation, recorded-data invalidation, and local viewing behavior. The [profile browser smoke](../../../../work-assistant/profile-tests/profile-smoke.mjs) exercises the packaged plugin with an isolated home and AgentLoop-generated synthetic recorded calendar and memory results; fixture evidence is not a real Copilot round.

The existing [docking](../feature/2026-09-04-right-sidebar-docking-infrastructure.md), [tab navigation](2026-09-05-sidebar-tab-types-and-navigation.md), [responsive layout](2026-09-07-sidebar-responsive-tab-info.md), and [locale ownership](2026-08-23-locale-owned-client-ui-copy.md) decisions remain active. This deployment selects a presentation; it does not supersede their framework or ownership rules.
