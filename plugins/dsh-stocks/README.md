---
description: "MoYu market charts, local watchlists, provider credentials, and source-download access in this fork's Web profile."
kind: "package-bundle"
---

# MoYu for DeepSeek Harness

English | [中文](README.zh.md)

## Summary

Browse the U.S. market, manage a saved watchlist, and open stock charts beside Dashboard and Taskboard. Stocks adapts OpenStock under AGPL-3.0 without modifying the DSH shell or OpenStock checkout.

## Table of Contents

- [Use Stocks](#use-stocks)
- [Install and build](#install-and-build)
- [Configuration and privacy](#configuration-and-privacy)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [License and source](#license-and-source)
- [Dev Note](#dev-note)

<a id="use-stocks"></a>
## Use Stocks

Select **MoYu** in the left sidebar. Overview provides pulse quotes, grouped leaders (Financial, Technology, Consumer and Biotech), the S&P 500 heatmap, quotes and news. Use **+** or **Search stocks** to open a ticker. Overview and Watchlist stay pinned; up to ten closable stock tabs are remembered per browser. Arrow keys navigate the tab strip.

Stock tabs provide TradingView charts, financials, technicals, profiles and news, plus optional Reddit sentiment. Use **Add to watchlist** to save a symbol. Watchlist rows open detail tabs and support sorting/removal. With Finnhub configured, **Set price alert** saves an above/below target. Triggered alerts show their time in Watchlist; they do not send email or place trades.

<a id="install-and-build"></a>
## Install and build

From the DSH checkout, run `pnpm run setup:web` to build and install this package with the other [portable Web features](../README.md). For plugin-only development, run `pnpm install`, `pnpm test`, `pnpm run typecheck`, and `pnpm run build` in this directory. The package declares its bundle patch and browser entry. Stop and restart the target DSH Host after rebuilding, then reload the browser.

`setup:web` initializes an absent default statePath to `{ "version": 1, "revision": 0, "watchlist": [], "alerts": [] }`. The plugin reports missing/corrupt data without overwriting it. Changes require the last-read revision. A conflict means another window or alert check updated the file; refresh before retrying. A foreign lock blocks writes; stop its writer before repairing a stale lock.

<a id="configuration-and-privacy"></a>
## Configuration and privacy

Override the `dsh-stocks` Cordis row. A config replaces the whole earlier row config. The installed bundle sets statePath with `dshHomePath("stocks", "state.json")`.

| Field | Default | Purpose |
| --- | --- | --- |
| statePath | DSH home/stocks/state.json | Absolute watchlist/alert file |
| credentialsFile | unset | Optional absolute provider-key file |
| quoteRefreshSeconds | 60 | Quote cache and visible-page polling, 15–3600 seconds |
| alertCheckSeconds | 300 | In-app checks, 60–86400 seconds |
| requestTimeoutMs | 8000 | Provider deadline including queue wait |
| failureCacheSeconds | 60 | Failure cooldown |
| metadataCacheSeconds | 3600 | Profile/search cache lifetime |
| newsCacheSeconds | 300 | News cache lifetime |
| cacheEntries | 512 | Response-cache entry limit |
| maxResponseBytes | 1000000 | Provider response-body limit |

Set `FINNHUB_API_KEY` or comma-separated `FINNHUB_API_KEYS` in the DSH host environment for native quotes, company search, profiles, news and alerts. Set `ADANOS_API_KEY` for Reddit sentiment. The optional credentials file reads only these names plus `NEXT_PUBLIC_FINNHUB_API_KEY`; it never executes values. Environment keys take precedence. Reload the host plugin after changing credentials; a browser refresh alone does not reload host environment variables.

TradingView widgets work without provider keys. They run in sandboxed cross-origin frames with no DSH cookie or DOM access; no third-party script executes in the DSH document. Opening Stocks contacts TradingView. Native requests send requested symbols to Finnhub/Adanos. Keys stay on the host. Watchlists are shared by users of this DSH host, not by OpenStock account; keep DSH authentication enabled.

<a id="model-experience"></a>
## Model Experience

None. Stocks sends no model requests and adds no tools or conversation events.

### KV Cache effect

None; the plugin neither assembles nor changes model context.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

TradingView controls feed delays, coverage, licensing and external links. Use Stocks search, native rows or symbol chips for internal tabs; TradingView links open externally. Unsupported exchange charts offer an external link. Market-hours indicators exclude holidays. Missing provider data is unavailable, never replaced with invented prices.

Alerts run only while DSH is running and need fresh Finnhub quotes. They are not an email or execution system. Reddit sentiment needs Adanos; other OpenStock sentiment networks are not included. OpenStock login, billing, MongoDB account migration, marketing pages and cloud email jobs are outside this local plugin.

<a id="license-and-source"></a>
## License and source

See [LICENSE](LICENSE) and [NOTICE](NOTICE). **About MoYu → Download source** offers the plugin source and build-input archive through an authenticated route. Readable source is in [src](src/). Market definitions, exchange mappings and widget configurations are adapted from [OpenStock](https://github.com/Open-Dev-Society/OpenStock). Preserve source, modification and license notices when sharing this plugin.

<a id="dev-note"></a>
## Dev Note

None.
