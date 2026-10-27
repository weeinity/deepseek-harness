---
description: "构建并安装此分支可跨机器使用的 Web 功能，无需复制凭据或个人数据。"
---

# 可跨机器使用的 Web 功能

[English](README.md) | 中文

## 概述

在另一台机器上使用相同的 Dashboard、MoYu、OAuth 设置和扩展包。设置命令会构建 DSH 和仓库内的本地插件，然后将固定版本的扩展安装到 Web 配置中。凭据、连接器登录状态、会话和现有设置保留在各自机器上。

## 目录

- [设置另一台机器](#set-up-another-machine)
- [配置外部服务](#configure-external-services)
- [维护插件](#maintain-the-plugins)
- [开发备注](#dev-note)

<a id="set-up-another-machine"></a>
## 设置另一台机器

使用根目录[包清单](../package.json)支持的 Node 和 pnpm 版本。在此分支的检出目录中执行：

```powershell
git fetch origin
git switch integration/official-update
git pull --ff-only
pnpm install
pnpm run setup:web
pnpm dsh web
```

设置前停止目标 DSH Web 进程，完成后使用 `pnpm dsh web` 重启。设置命令不会启动或停止服务器。同步此分支后重新运行设置；仅执行 `pnpm run build` 只会构建核心应用，不会构建这些外部插件。

可以向智能体提出：“同步 `integration/official-update`，安装依赖，运行 `pnpm run setup:web`，然后启动 DSH Web。保留此机器的凭据和个人数据。”

设置默认使用 `web` 配置。`pnpm run setup:web --profile my-web` 可选择其他 Web 配置。`DSH_HOME` 按 DSH 的常规规则选择本地数据目录。

[设置清单](../scripts/setup-web.ts)定义确切版本和扩展包顺序。设置会保留不相关的配置依赖和扩展包，不会覆盖配置或主目录的补丁文件，仅在默认状态文件不存在时创建空的 MoYu 自选列表。它不会修复格式错误的现有状态。

如果命令失败，设置会停止。已完成的构建和包操作会保留；修正报告的问题后重新运行设置。包管理器构建批准和 DSH 兼容性检查仍然有效。

<a id="configure-external-services"></a>
## 配置外部服务

设置并重启后即可看到新增页面。访问数据仍需要在此机器上单独授权：

- **Dashboard：** 配置并登录 Agency WorkIQ/ADO 连接器以及选定的 DSH 模型。参阅其 [README](dsh-dashboard/README.zh.md)。
- **MoYu：** TradingView 组件需要网络访问。原生行情、新闻、搜索和提醒需要 Finnhub 密钥；可选的情绪数据需要 Adanos。参阅其 [README](dsh-stocks/README.zh.md)。
- **OAuth / Subscriptions：** 在设置中启用提供方并登录。令牌不会迁移。参阅其 [README](dsh-llm-oauth/README.zh.md)。
- **其他扩展：** 单独配置其外部命令、账号、浏览器工具和服务密钥。

不要复制整个 `.dsh` 目录，也不要将 `.env`、OAuth 存储、连接器凭据、缓存、历史记录或个人简报文件添加到 Git。

<a id="maintain-the-plugins"></a>
## 维护插件

Dashboard、OAuth 和 MoYu 的源代码位于此目录中，因为它们包含本地定制。每个插件都有独立的依赖锁文件、构建、类型检查和测试；它们不属于核心工作区。第一方依赖使用指向此检出目录的相对路径链接。其他扩展按设置中记录的确切注册表版本或 Git 修订版本安装。

验证浏览器功能时，使用已安装的 `playwright-cli` 会话，并打开已认证的英文 Web 页面。关闭首次使用对话框，然后在该会话中运行 `playwright-cli run-code --filename=plugins\tests\web-setup-smoke.mjs`。此[浏览器检查](tests/web-setup-smoke.mjs)打开 Dashboard、MoYu 和 OAuth 设置，检查侧栏 Host 路由与 MoYu 源代码下载，并确认无效行情输入被拒绝，不会登录数据提供方或修改已保存的数据。

保留各插件的许可和声明。OAuth 使用 MIT 许可。MoYu 保留 AGPL-3.0-only 许可、OpenStock 署名以及需要身份验证的源代码下载功能。Dashboard 提供的私有包没有单独的许可声明。

<a id="dev-note"></a>
## 开发备注

无。
