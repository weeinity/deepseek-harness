---
description: "Search configured MCP connectors and change their persistent enablement from Web Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-connectors

English | [中文](README.zh.md)

## Summary

Open **Settings → Connectors** to find the MCP servers configured for the current DSH profile and enable or disable them. Search matches server names, entry identifiers, and transports in one list. Each connector has an identity mark and an enablement switch that keeps its row in place. Changes wait for Host acknowledgment; failures remain visible instead of appearing successful. The page follows the current language and light or dark theme.

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

The [Web bundle](../../bundle/web-app/README.md) mounts this page in the Settings navigation. It lists configured global MCP entries, including disabled entries, but does not list per-agent preset instances or install new servers.

Type in **Search connectors** to filter the list. Entries retain their configured order regardless of enablement. **Refresh connectors** reads the current Host state; an empty search result differs from a profile with no configured connectors.

Use a connector's switch to change its persistent enablement. Other switches remain disabled while that write is pending. The profile manager serializes configuration writes. Success and failure notices remain visible if Settings closes before the write finishes. If saving succeeds but activation fails or an override prevents the change, the notice reports that distinction and asks for configuration review and a DSH restart.

**Enabled** describes plugin enablement, not a successful MCP handshake. Starting, waiting, stopping, failed, and unobserved Loader states remain separate. Unsupported targets and non-writable contexts have disabled switches with padlocks and explanations; pending writes disable switches without padlocks.

Known names, including Teams, use service logos or colored glyphs; unknown names use uppercase initials, and blank names use a plug. Marks retain their color across enablement and failure states. Transport remains in the subtitle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The browser registers one lazy `settings.section` contribution, reads redacted metadata from the [plugin inventory](../../host/plugin-inventory/README.md), and delegates writes to the [profile plugin manager](../../boot/plugin-manager/README.md). It keeps a last-read snapshot and filters it locally. Late responses cannot replace a newer read or update an unmounted page.

Only allowlisted connector metadata reaches the page. It neither reads connection credentials nor downloads remote icon URLs. The shared [UI primitives](../ui-primitives/README.md) supply the navigation glyph, search field, and switches.

`ConnectorMark` resolves a case-insensitive name lookup to bundled logos or Phosphor fill SVGs with [theme-owned](../ui-theme/README.md) colors. Logo artwork is cropped, proportionally centered, and stored as 102px PNG data URLs in `connector-logos.ts`; opening Settings makes no image HTTP requests. All decorative tiles are 34px with 9px corners, including application-owned overrides. Neutral fallbacks follow the theme; names remain the accessible identity.

No runtime invariant companion is published: this page owns only local presentation state; persistence, target authorization, and configuration application belong to the Host.

Localized plugin titles are published at `./locale/*.json`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client](../../mcp/mcp-client/README.md) — server configuration and tool lifecycle.
- [Settings base](../ui-settings/README.md) — page contributions and Settings services.
- [Settings shell](../ui-settings-general/README.md) — navigation, dialog, and theme composition.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [MCP client](../../mcp/mcp-client/README.md), which owns tool registration when the Host applies an enablement change.

#### KV Cache effect

Enabling or disabling a server changes the available tool definitions for subsequent requests. Provider cache reuse is outside this page's control.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The page manages configuration, not server installation or transport health.

- The directory refreshes on page open, manual refresh, and successful writes; it is not a live MCP health monitor.
- Only already-configured global MCP servers appear. Adding servers and editing credentials remain configuration operations.
- A Host without supported writable profile control exposes metadata read-only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
