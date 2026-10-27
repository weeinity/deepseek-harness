---
description: "Build and install this fork's portable Web features without copying credentials or personal data."
---

# Portable Web features

English | [中文](README.zh.md)

## Summary

Use the same Dashboard, MoYu, OAuth settings, and extension bundles on another machine. The setup command builds DSH and the checked-in local plugins, then installs the pinned extensions into a Web profile. Credentials, connector sign-ins, sessions, and existing settings stay on each machine.

## Table of Contents

- [Set up another machine](#set-up-another-machine)
- [Configure external services](#configure-external-services)
- [Maintain the plugins](#maintain-the-plugins)
- [Dev Note](#dev-note)

<a id="set-up-another-machine"></a>
## Set up another machine

Use Node and pnpm versions supported by the root [package manifest](../package.json). From this fork's checkout:

```powershell
git fetch origin
git switch integration/official-update
git pull --ff-only
pnpm install
pnpm run setup:web
pnpm dsh web
```

Stop the target DSH Web process before setup, then restart it with `pnpm dsh web`. The setup command does not start or stop servers. Repeat setup after syncing this branch; `pnpm run build` alone builds the core application, not these external plugins.

For an agent, request: "Sync `integration/official-update`, install dependencies, run `pnpm run setup:web`, and start DSH Web. Keep this machine's credentials and personal data."

Setup uses the `web` profile by default. `pnpm run setup:web --profile my-web` selects another Web profile. `DSH_HOME` selects the local data directory using the normal DSH rules.

The [setup manifest](../scripts/setup-web.ts) owns the exact versions and bundle order. Setup preserves unrelated profile dependencies and bundles, does not overwrite profile or home patch files, and creates an empty MoYu watchlist only when its default state file does not exist. It does not repair malformed existing state.

If a command fails, setup stops. Completed builds and package operations remain in place; correct the reported problem and rerun setup. Package-manager build approvals and DSH compatibility checks remain enforced.

<a id="configure-external-services"></a>
## Configure external services

The additional pages appear after setup and restart. Data access still requires this machine's own authorization:

- **Dashboard:** configure and authenticate Agency WorkIQ/ADO connectors and the selected DSH model. See its [README](dsh-dashboard/README.md).
- **MoYu:** TradingView widgets need network access. Native quotes, news, search, and alerts need Finnhub keys; optional sentiment needs Adanos. See its [README](dsh-stocks/README.md).
- **OAuth / Subscriptions:** enable a provider and sign in from Settings. Tokens are not transferred. See its [README](dsh-llm-oauth/README.md).
- **Other extensions:** configure their external commands, accounts, browser tools, and service keys separately.

Do not copy a complete `.dsh` directory or add `.env`, OAuth stores, connector credentials, caches, histories, or personal briefing files to Git.

<a id="maintain-the-plugins"></a>
## Maintain the plugins

Dashboard, OAuth, and MoYu sources live in this directory because they contain local customizations. Each plugin has its own dependency lockfile, build, type-check, and tests; they are not core workspaces. First-party dependencies link to this checkout through relative paths. Other extensions install from the exact registry versions or Git revision recorded by setup.

For browser verification, use an installed `playwright-cli` session with an authenticated English Web page. Dismiss the first-use dialogs, then run `playwright-cli run-code --filename=plugins\tests\web-setup-smoke.mjs` in that session. This [browser check](tests/web-setup-smoke.mjs) opens Dashboard, MoYu, and OAuth settings, checks the sidebar Host routes and MoYu source download, and rejects invalid quote input without signing in to providers or changing saved data.

Preserve each plugin's licensing and notices. OAuth is MIT-licensed. MoYu retains its AGPL-3.0-only license, OpenStock attribution, and authenticated source-download facility. Dashboard has no separate license declaration in its supplied private package.

<a id="dev-note"></a>
## Dev Note

None.
