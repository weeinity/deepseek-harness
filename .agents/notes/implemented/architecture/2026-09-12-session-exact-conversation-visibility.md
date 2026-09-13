# Agent Note: Session-exact Conversation View visibility

Status: implemented

English | [中文](2026-09-12-session-exact-conversation-visibility.zh.md)

## Problem

An optional Conversation View can be useful in selected chats without belonging in every chat or its subagents. A globally registered Slot row alone cannot express that choice. Tab rendering, persisted selection, and programmatic navigation must agree for every live Session binding.

## Decision

`UiConversation.visibility` owns one optional observable Session-id allowlist per View id. A registered policy permits only exact entries equal to `true`; absence of a policy preserves unrestricted Views. Policies can precede their Slot row and belong to the registering plugin's Cordis effects, including source unsubscription.

The shell projects a stable visible roster per `SessionBinding` for both header and body. Slot, locale, and policy changes refresh all live rosters. Binding replacement and teardown remove only the record owned by that binding, so delayed old cleanup cannot remove a newer record with the same Session id. Preferred hidden Views fall back to visible Chat without losing the preference. Shell navigation and direct target activation check visibility before new activation; already active targets retain the assembler's monotonic lifetime.

The [Session and Conversation ownership decision](2026-08-20-client-session-conversation-ownership.md) remains authoritative for data ownership and standard sources. This policy adds presentation filtering without moving those responsibilities or changing the global Slot ledger.

## Alternatives considered

**Hide DOM elements.** Removing a tab visually does not prevent restoration, focus requests, or target activation, and leaves the body and header able to disagree.

**Register or unregister the global View from current-Session changes.** A global roster cannot represent two live Sessions with different choices. Navigation would also transfer ownership of another plugin's contribution.

**Inherit the parent's opt-in.** Exact per-chat enablement excludes child Sessions unless they have their own explicit entry. Lineage is not permission.

## Consequences

Optional View owners supply and persist their own policy source; the framework owns no feature setting or global singleton. Removing a policy restores unrestricted behavior, so a plugin that also owns the View removes its Slot row before removing the policy. Visibility is not data authorization, cancellation, or target deactivation.

Focused wiring and registry tests exercise unrestricted Views, exact parent/child separation, simultaneous bindings, hidden navigation, reactive preference restoration, labels, unload, and same-id binding replacement. Browser composition remains the consumer's verification responsibility because no shipped View opts into this policy by default.
