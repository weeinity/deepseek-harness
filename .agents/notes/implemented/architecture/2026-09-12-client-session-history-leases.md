# Agent Note: Controller-owned exact-session history leases

Status: implemented

English | [中文](2026-09-12-client-session-history-leases.zh.md)

## Problem

An independent reader needs the native history and live Assistant state of an exact Host Session without replacing the application's selected Session. Resolving a binding alone supplies a cold event source. Using navigation to open that source changes unrelated UI state, while a separate transport duplicates the controller's history reconciliation.

## Decision

The [Session Controller](../../../../packages/api/session-controller/README.md#client-history-leases) owns `ISessions.retain(sessionId, signal?)` and `SessionLease`. Acquisition opens the existing native Session and resolves after its follow baseline is installed. Multiple leases share the same binding and source. A root Session may be absent from the Client list, but it must satisfy the existing Host address and history-read eligibility rules, including header cwd. Leases do not make otherwise unreadable Sessions accessible.

Navigation is a resident history owner: switching away does not close the history it opened. Leases add independent, bounded ownership without changing that behavior. The last lease-only owner releases the history window, cancels its reads, and awaits iterator and page completion; it does not cancel Agent work. A listed binding survives read release, while an unlisted lease-only scope leaves with its final owner. Generation guards prevent released reads from mutating a subsequent owner's state.

Caller cancellation releases only that lease, including after readiness. Explicit ordinary-Session removal and controller disposal end leases; a list refresh that omits an id does not. Opening errors reject acquisition, and later follow errors remain in the native Session snapshot. Readiness is neither full-history loading nor Agent completion.

## Alternatives considered

**Select the Session to open it.** This makes independent reads mutate global navigation and excludes consumers that must keep their private Session off the ordinary current view.

**Expose concrete `Session.open()` or create another follow stream.** A bare open has no release owner, and another stream duplicates existing Assistant settlement and continuity handling. The public lease exposes only the native binding and release.

**Close navigation history whenever selection changes.** This changes established off-screen updates and scope lifetimes. Resident navigation ownership remains independent of disposable reader ownership.

## Consequences

The Client API gains a resource lifetime, not another transport or Conversation renderer. Callers must release leases and stop using released bindings. Navigation-opened histories remain warm until their existing scope teardown; lease release cannot reclaim another owner's source.

[Focused tests](../../../../packages/api/session-controller/tests/session-lease.client.spec.ts) verify two-session isolation, shared readiness, navigation sharing, cancellation, removal, failure, pending-page containment, and quiescent disposal over the real Client Session and Gateway journal with a programmable Remote. That Remote does not verify Host header or address eligibility. Private GUI composition and real-model transcript evidence belong to the consuming panel, not this data-layer API.

## Related decisions

The [Client ownership decision](2026-08-20-client-session-conversation-ownership.md) remains active for Controller, Conversation, and renderer separation. The [scope parity decision](2026-07-25-web-client-session-scope-and-provide-channel.md) remains active for Agent identity and scoped effects; leases extend its list-driven scope eligibility without replacing those rules. The [transport decision](2026-08-18-session-history-and-event-transport.md) remains active for Remote lifecycle and reconciliation. None is fully superseded.
