---
description: "此分支 Web profile 中的 MoYu 市场图表、本地自选股、服务凭据及源代码下载。"
kind: "package-bundle"
---

# DeepSeek Harness MoYu 插件

[English](README.md) | 中文

## 摘要

浏览美国市场、管理持久化自选股，并在 Dashboard 和 Taskboard 同级打开股票图表。Stocks 按 AGPL-3.0 改编自 OpenStock，不修改 DSH 外壳或 OpenStock 检出目录。

## 目录

- [使用股票插件](#use-stocks)
- [安装与构建](#install-and-build)
- [配置与隐私](#configuration-and-privacy)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [许可与源代码](#license-and-source)
- [开发备注](#dev-note)

<a id="use-stocks"></a>
## 使用股票插件

选择左侧 **MoYu**。概览提供指数行情、板块走势（金融、科技、消费和生物科技）、标普 500 热力图、报价和新闻。使用 **+** 或 **搜索股票** 打开代码。概览和自选股固定显示；浏览器记住最多十个可关闭的股票标签。方向键可切换标签。

股票标签提供 TradingView 图表、财务、技术分析、简介、新闻及可选 Reddit 情绪。使用 **加入自选** 保存股票。自选股行支持打开详情、排序和移除。配置 Finnhub 后，**设置价格提醒** 可保存高于/低于目标价的条件。触发时间显示在自选股页；不会发送邮件或执行交易。

<a id="install-and-build"></a>
## 安装与构建

在 DSH 检出目录运行 `pnpm run setup:web`，随其他[可跨机器使用的 Web 功能](../README.zh.md)一起构建并安装此包。仅开发此插件时，在此目录运行 `pnpm install`、`pnpm test`、`pnpm run typecheck` 和 `pnpm run build`。此包声明了配置补丁和浏览器入口。重新构建后停止并重启目标 DSH Host，然后刷新浏览器。

`setup:web` 将不存在的默认 statePath 初始化为 `{ "version": 1, "revision": 0, "watchlist": [], "alerts": [] }`。插件报告缺失或损坏的数据，但不覆盖。修改需要最后读取的版本号。冲突表示其他窗口或提醒检查更新了文件，请刷新后重试。其他写入程序持有的锁会阻止写入，修复过期锁之前必须停止其写入程序。

<a id="configuration-and-privacy"></a>
## 配置与隐私

覆盖 `dsh-stocks` Cordis 配置行。新 config 替换整行原配置。安装补丁通过 `dshHomePath("stocks", "state.json")` 设置 statePath。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| statePath | DSH home/stocks/state.json | 自选股与提醒文件的绝对路径 |
| credentialsFile | 未设置 | 可选的服务密钥文件绝对路径 |
| quoteRefreshSeconds | 60 | 行情缓存及可见页面轮询，15–3600 秒 |
| alertCheckSeconds | 300 | 应用内检查，60–86400 秒 |
| requestTimeoutMs | 8000 | 含排队时间的数据服务请求期限 |
| failureCacheSeconds | 60 | 失败冷却时间 |
| metadataCacheSeconds | 3600 | 简介与搜索缓存时间 |
| newsCacheSeconds | 300 | 新闻缓存时间 |
| cacheEntries | 512 | 响应缓存条目上限 |
| maxResponseBytes | 1000000 | 服务响应体大小上限 |

在 DSH 主机环境设置 `FINNHUB_API_KEY` 或逗号分隔的 `FINNHUB_API_KEYS`，以启用原生报价、公司搜索、简介、新闻和提醒。设置 `ADANOS_API_KEY` 以启用 Reddit 情绪。可选密钥文件仅读取这些名称及 `NEXT_PUBLIC_FINNHUB_API_KEY`，绝不执行值。环境密钥优先。修改密钥后重新加载主机插件，仅刷新浏览器不会重新加载主机环境变量。

TradingView 组件不需要服务密钥。组件在沙箱化跨源框架中运行，无法访问 DSH Cookie 或 DOM；第三方脚本不会在 DSH 文档中执行。打开股票插件会连接 TradingView，原生请求向 Finnhub/Adanos 发送所请求的股票代码。密钥保留在主机。自选股由此 DSH 主机用户共享，不按 OpenStock 账号隔离；请保持 DSH 身份验证开启。

<a id="model-experience"></a>
## 模型体验

无。股票插件不发送模型请求，也不添加工具或会话事件。

### KV 缓存影响

无；插件不组装或修改模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

TradingView 控制行情延迟、覆盖、授权及外部链接。使用插件搜索、原生列表或代码按钮打开内部标签；TradingView 链接在外部打开。不支持嵌入的交易所图表提供外部链接。市场时段指示不包含节假日。缺失数据标为不可用，不以虚构价格代替。

价格提醒仅在 DSH 运行时检查，且需要新鲜 Finnhub 行情；它不是邮件或交易系统。Reddit 情绪需要 Adanos，未包含 OpenStock 其他情绪网络。本地插件不包含 OpenStock 登录、计费、MongoDB 账号迁移、营销页面或云端邮件任务。

<a id="license-and-source"></a>
## 许可与源代码

参见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。**关于 MoYu → 下载源代码** 通过已认证路由提供插件源代码与构建输入。可读源码位于 [src](src/)。市场定义、交易所映射和组件配置改编自 [OpenStock](https://github.com/Open-Dev-Society/OpenStock)。分享此插件时保留源代码、修改声明和许可说明。

<a id="dev-note"></a>
## 开发备注

无。
