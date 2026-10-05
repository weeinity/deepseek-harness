---
description: "Personal-assistant action approvals, scoped interaction admission, exact tool admission, and durable audit metadata."
kind: "package-bundle"
---

# Personal action gateway

English | [中文](README.zh.md)

## Summary

Expose only explicitly registered assistant actions and the exact scoped user-question tool admitted by the preset. Reads run without a prompt; every write needs a fresh DSH one-time approval. Missing, rejected, cancelled, unavailable, or stale approvals cannot dispatch the write.

## Contents

- [Configuration](#configuration)
- [Audit and ownership](#audit-and-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## Configuration

This bundle inserts `wa-gateway`. Its required `ownerId` identifies the single-user deployment and must contain 1–80 letters, digits, dots, underscores, or hyphens, starting with a letter or digit. The bundle uses `personal`; a profile patch may replace it.

Mount only in a dedicated personal profile. The monotonic guard checks the exact registered definition, denying similarly named tools, scoped shadows, and tools force-allowed by another pre-execute policy. Unloading a connector or the preset interaction plugin removes its admission. The profile must also omit generic shell, filesystem, code execution, browser, and arbitrary network tools.

Trusted connector plugins register a tool definition and a fixed read/write policy. The gateway derives the Session and tool-call identities from DSH's execution context; model arguments cannot select another owner, Session, policy, credential, or taint value. Credentials are resolved at use through DSH's credential service and must never enter tool arguments or responses.

The preset may admit the published `ask_user_question` definition by identity for one agent scope. That interaction is not connector dispatch: DSH's normal question and tool events record it, and an answer never grants permission for a calendar, memory, or other write.

<a id="audit-and-ownership"></a>
## Audit and ownership

The `workassist` storage domain uses the configured DSH storage backend. SQLite is supplied by DSH, not a second database implementation. Domain version 1 stores one record per connector invocation: owner, Session, call, connector, method, argument digest, exposure flag, decision, and dispatch outcome. DSH's Session log owns argument bodies, tool results, approval request/decision events, and user-question events.

Admission is persisted before dispatch. Storage failure prevents a new action. Interrupted records are marked on restart, never replayed. A failure after dispatch does not prove that a side effect did not happen; this package never retries it automatically. On unload, pending actions are cancelled and joined before the domain closes.

The gateway snapshots JSON arguments before audit, approval, and dispatch, so the recorded digest and dispatched payload are the same reviewed input. From write audit admission until dispatch starts, newer direct human input for the same live agent cancels that approval; relayed context and other agents do not.

The exposure flag conservatively records attempted reads of external content and survives restart. It is audit metadata, not a substitute for approval: writes always ask even in an unexposed Session.

<a id="model-experience"></a>
## Model Experience

Denied calls, approval outcomes, and user-question failures are visible through ordinary DSH tool results. Successful connector output is owned by the registering connector. Successful user-question output is owned by the published ask-user tool. No audit payload or secret is injected into model context by this bundle.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Only single-user deployments and one-time approvals are supported; there are no session-wide or perpetual grants.
- Plugins and configuration are trusted code. An in-process credential reference is not isolation from a malicious plugin.
- Interaction admission is limited to `ask_user_question`; it is a guard admission for human input, not a connector policy path.
- An audit outcome describes connector dispatch, not later tool-result presentation or delivery to a user.
- No runtime invariant companion is supplied: the DSH domain owns record validation and the tool registry owns admission effects.
