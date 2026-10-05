---
description: "Show assistant context beside chat and occasional model-chosen acknowledgement reactions."
kind: "package-bundle"
---

# @deepseek-ai/dsh-wa-ui

English | [中文](README.zh.md)

## Summary

Keep conversations, pending work, and recorded calendar and memory results beside the chat in a Nocturne light/dark layout. The personal-assistant setup includes this bundle; other profiles keep their existing layout unless they also install it. Calendar and memory shortcuts copy suggested requests for you to paste and send through normal chat. The assistant can occasionally acknowledge a message with a reaction instead of a separate text reply.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

The package manifest declares `dsh.bundle.patch`, and the patch inserts one `wa-ui` Cordis row for `@deepseek-ai/dsh-wa-ui`. The work-assistant setup flow owns packing and installing this private bundle with the rest of the personal-assistant profile. Do not add a second profile row by hand; the bundle expects the published web client services already present in that profile.

### What you get

The right-hand panel shows the Harness identity and five keyboard-accessible tabs. Timeline opens recent nonblank personal-assistant conversations. Queue shows pending interactions and running conversations; Review opens the existing interaction UI without approving it. Day and Memory show recorded tool results from the selected conversation's loaded history, not a live calendar or global memory inventory.

Close the panel with its top-right button and reopen it with the sidebar's `Show assistant panel` control. The compact left rail retains DSH navigation. Theme tokens follow the existing light/dark preference. The main conversation, composer, model selection, and approvals remain owned by DSH.

`Connected to DSH` describes the browser's connection to DSH, not Copilot sign-in or calendar availability. Conversation rows represent saved conversations, not inferred completed tasks.

Set `maxActivities` from 1 through 20 on the `wa-ui` row to change the default six rows per bounded conversation section. Set `defaultTab` to `timeline`, `queue`, `day`, `memory`, or `inbox`; the default is `timeline`. Reload the page after the Host loads configuration changes. Viewing state stays in the browser; the bundle does not scan other conversations or create an activity database.

### Proactive Inbox

Inbox displays saved messages from the [briefing service](../wa-briefing/README.md#inbox-and-pause). The sidebar badge shows unread messages even when the panel is closed; the panel header previews the latest unread message on every tab. Neither changes focus or the current conversation automatically. Open and reply marks the item read and opens its ordinary conversation; it does not send input or overwrite a draft. Mark read and Dismiss persist through restart. Pause cancels in-flight preparation and persists; Resume allows future configured occurrences only. The UI cannot enable a deployment whose briefing schedule is disabled.

The browser reads the same-origin Inbox on mount, reconnect, explicit refresh, and at `inboxRefreshIntervalMs` intervals (default 15000, range 1000–300000). `inboxRequestTimeoutMs` bounds each request and response body (default 10000, range 100–120000). Failed requests show an error and retain the last verified snapshot; no optimistic action success is displayed. Polling never creates model work. No browser push or external notification is provided.

<a id="acknowledgement-reactions"></a>
### Acknowledgement reactions

The optional `receipt` configuration requires explicit `presetIds` and a `style` of `thumbs-up`, `neutral`, or `off`. Empty, duplicate, or whitespace-padded preset IDs are rejected. Omitting `receipt`, setting it to `null`, or selecting `off` leaves assistant replies in the ordinary transcript. Enabled reactions require the shared Chat `conversation.chat.user-badges` extension; an unpatched published Chat package is not sufficient.

```yaml
receipt:
  presetIds: [personal-assistant]
  style: thumbs-up
```

When the assistant chooses a standalone thumbs-up reply, an eligible user message shows a rounded reaction chip attached to its lower-right edge, labeled `Assistant acknowledged your message.` The chip replaces the separate emoji reply in Chat and remains separate from the user's copied text and copy/time controls. Neutral style displays `Received`. Eligibility requires the selected Session's resolved preset and trusted Web ingress provenance. Reaction identity follows the exact user and assistant message IDs, not matching text.

A reaction is the assistant's conversational choice, not a delivery or read receipt. Normal text replies, mixed emoji-and-text replies, optimistic sends, queued input, and incomplete or cancelled replies do not create reactions. The normal assistant reply stays in the durable log; reopening history adds no model call or acknowledgement event. Disabling the presentation restores the ordinary emoji reply without rewriting the log. Reactions grant no approval and prove no completed work. Existing assistant-response feedback controls remain separate.

### Recorded results and shortcuts

Day and Memory require versioned presentation metadata from the calendar and memory bundles. Missing, unsupported, malformed, failed, and truncated results are reported explicitly. Memory write receipts do not contain note previews; changed revisions, failed writes, and complete lists that omit a note invalidate older previews. A truncated list cannot prove that an omitted note was deleted.

`Copy calendar request` and `Copy memory request` use the browser clipboard without navigating, modifying an existing draft, or sending input. Paste and review the request in the normal composer; its workspace and model requirements still apply. If copying fails, select the displayed request text and copy it manually.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[Host registration](src/index.ts) publishes only validated display settings through the Web server's structured global injection. The browser validates this page-local value; missing Host configuration fails startup instead of silently disabling configured receipts. [Client registration](src/client/index.ts) owns locale dictionaries, theme overrides, CSS, and slot replacements through Cordis effects.

A strict Session header bridge publishes the loaded chat view into a root-owned observable; the rightbar reads it only when its Session matches the selected conversation. The root and Session slots do not share a StoreDefinition. `cordis.patch.yml` inserts only the `wa-ui` row.

The package does not publish `./invariant`. Its owned facts are slot registrations, component rendering, local UI state, and a read-through Inbox snapshot; there is no independent runtime resource, durable format, or cross-process relationship for an invariant installer to compare.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Patch document](cordis.patch.yml)
- [Client registration](src/client/index.ts)
- [Panel component](src/client/AssistantPanel.tsx)
- [Component tests](tests/assistant-panel.client.spec.tsx)

-----

<a id="model-experience"></a>
## Model Experience

### Browser UI rendering

#### What the model sees

Opening tabs or copying requests sends nothing to the model. The bundle registers no tools, prompt contributions, or model request metadata. If you paste and send a suggested request, it becomes normal logged user input. The English suggestions are:

- `Show my calendar for today. Use an explicit local time window and summarize conflicts only if the calendar data shows them.`
- `Help me add one personal memory note. Ask me which single note to save before writing.`

#### Token effect

Viewing and copying have zero direct token effect. Explicitly sent suggestions consume normal user-input tokens.

Reaction presentation adds no model request or tokens beyond the assistant's ordinary reply and does not authorize tools. The optional emoji-reply guidance and human-question tool belong to the [personal-assistant preset](../wa-preset/README.md), not this UI entry.

#### KV Cache effect

The bundle does not modify model request fields. Explicitly sent suggestions have the ordinary cache effect of new user input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **File and resource previews** — The assistant panel replaces the stock file/resource docking presentation and its header control. Do not install this bundle in profiles that need those preview panes.
- **Panel width** — DSH owns the default width and drag resizer. This bundle cannot set a 340px default; resized width is not retained across page reloads.
- **Recorded data** — Calendar and memory rows can be incomplete or stale. They describe loaded recorded results, not current external state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
