# Agent Note: Profile-owned MCP connector controls

Status: implemented

English | [中文](2026-09-13-profile-owned-mcp-connector-controls.zh.md)

## Problem

A browser toggle must survive restart without changing a different plugin or overwriting unrelated profile configuration. Loader entries alone do not identify their writable source: bundle defaults, profile edits, home overrides, invocation overlays, and nested compositions can contribute to the same visible tree. An active MCP plugin also does not prove that its transport is connected.

## Decision

The Connectors settings page lists configured global MCP entries, including disabled entries, in their configured order. Enablement changes preserve row identity and position in the single list. It projects allowlisted names, identifiers, transports, and Loader phases; commands, arguments, endpoints, headers, environment values, and executable configuration expressions are not browser metadata.

The client resolves names to locally bundled identity marks; unknown names use monograms. Logo pixels ship in the client bundle; profile data cannot choose an image URL. Mark colors do not indicate enablement or transport health. Read-only controls show a padlock without muting the mark; pending writes disable controls without implying a configuration restriction.

The profile boot owner supplies the write capability. It maps complete Loader identities to supported profile-local targets and persists only the target's `disabled` override in the profile patch. Unknown or unsupported targets, higher-priority overrides, non-loopback Web deployments, and contexts without that owner cannot mutate configuration. Disabled configuration is not evaluated merely to display a row.

Writes carry a revision from the last directory read, serialize through the owner, and refuse stale observed configuration. YAML-aware editing preserves unrelated rows and trusted `!!js` expressions. Persistence and Loader application have separate outcomes: a saved change can require restart, and that receipt is not reported as active success. The browser adopts the returned snapshot without optimistic toggle state.

This retains the [profile composition order](../architecture/2026-08-05-profile-plugin-bundles.md) and the [MCP client's configured identity and tool lifecycle](2026-07-07-mcp-client-plugin.md). It adds enablement control, not a second server registry or an API for installing servers.

## Alternatives considered

**Call `loader.update()` and treat completion as persistence.** Root writes can be no-ops and deferred write errors do not form an awaited durable acknowledgment. A successful Loader operation is not sufficient evidence that restart uses the requested value.

**Write the composed Loader tree.** Flattening the tree loses source ownership and can persist evaluated configuration. Editing the owned profile patch preserves composition and keeps private connection data outside the browser command.

**Store a second connector directory in user settings.** Launch already reads profile composition. An independent enablement store would require reconciliation and could disagree with explicit configuration.

**Label active plugins “Connected.”** The MCP supervisor can reconnect or retain a nonfatal startup failure while its Loader fiber is active. Enablement and Loader phase are the observations available here; transport health remains a separate concern.

**Use transport as the connector icon.** Servers sharing a transport become visually indistinguishable. Identity marks distinguish them without adding connection data or remote image requests; transport remains explicit text.

## Consequences

The page supports persistent controls for writable configured targets while explaining why other rows are read-only. Higher-priority configuration remains authoritative rather than being silently changed by a lower-priority editor.

The profile owner carries the persistence complexity; the browser carries no connection secrets or configuration serializer. Tool availability changes through the existing MCP lifecycle, without model requests from Settings.

Focused coverage includes real Loader composition and MCP tool registration, stale and concurrent writes, configuration preservation, application failure, and owner disposal. Browser component coverage includes filtering, localized refusal messages, pending writes, stale responses, stable row order, and keyboard focus after toggling.
