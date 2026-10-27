---
description: "此分支的 OAuth 订阅提供方、本地登录、模型发现及 Web 设置页。"
kind: "package-bundle"
---

# dsh-llm-oauth

[English](README.md) | 中文

## 摘要

登录 OAuth 订阅提供方，在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用其模型。此分支包含定制的插件源代码；[可跨机器使用的 Web 功能设置](../README.zh.md)会安装 Host 和设置页，不会在机器之间迁移令牌。

![设置 → OAuth / 订阅](docs/oauth-subscriptions.png)

官方 `dsh-llm-pi-ai` 只走 API Key，没有 OAuth 登录/刷新。本插件复用同一份 catalog 包 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)，并把 `CredentialStore` 接进去，请求时会自动刷新订阅 token。

仓库形态对齐官方插件文档——[第一个插件](../../docs/user/develop/basic/index.zh.md)、[发布 / 安装](../../docs/user/develop/basic/publish.zh.md)：

- `package.json` → `dsh.bundle.patch` + 可选 `dsh.client`（Web 设置页）
- `cordis.patch.yml` 插入一行插件
- `prepare` 在 git 安装时把 `src/` 打成 `lib/`（含 `lib/client.js`）
- 函数形态：导出 `name`、`inject`、`Config`、`apply`，**无 `export default`**

## 目录

- [支持的订阅](#providers)
- [开启模型 vs 登录](#enable-vs-sign-in)
- [安装](#install)
- [设置 → OAuth / 订阅](#settings--oauth--subscriptions)
- [ChatGPT / Codex：先打开设备码授权](#chatgpt--codex-enable-device-code-auth-first)
- [命令行 / 斜杠命令](#login--commands)
- [不要和 llm-pi-ai 抢同一条路由](#do-not-collide-with-llm-pi-ai)
- [开发](#develop)
- [限制](#limits)
- [License](#license)
- [开发备注](#dev-note)

<a id="providers"></a>
## 支持的订阅

| 你想用的订阅 | provider id | 说明 |
|---|---|---|
| Grok（SuperGrok / X Premium） | `xai` | 模型 id 来自已安装的 pi-ai catalog。 |
| GitHub Copilot | `github-copilot` | 可选 Enterprise URL 默认留空，即公开的 `github.com`。 |
| ChatGPT / Codex 订阅 | `openai-codex` | **不是** `openai` API Key。必须先在 ChatGPT 设置里打开设备码授权，见下文。**有封号风险。** |
| Anthropic 订阅 | `anthropic` | |
| OpenRouter | `openrouter` | catalog 很大，确认需要再开启。 |
| Kimi For Coding | `kimi-coding` | |

GitHub Copilot 模型直接来自当前账号经过认证的 `/models` 接口，复用 pi-ai 的 OAuth 凭据和账号 API 地址，不经过本地 shim。每次列出模型及开始流式请求时都会刷新目录。元数据解析复用该目录，首次使用时才获取，因此打开选择器不会为每个模型单独请求目录。刷新按顺序执行，含排队时间在内最多等待 20 秒；不会后台轮询，也不会回退到过期目录。认证、网络或元数据格式错误会使元数据缓存失效并明确报错，下一次操作会重试。

Copilot 目录包含模型选择器允许的聊天模型，排除策略已禁用或明确不支持工具、流式输出的模型，并使用接口提供的输入类型、token 上限、推理等级及 HTTP 端点。仅 Individual 账号在没有合格选择器条目时允许使用策略明确开启的模型，其他账号类型不采用此回退。OAuth 刷新及原生 Responses、Messages、Chat Completions 请求仍由 pi-ai 处理，并保留已安装模型的兼容设置。因此，静态 catalog 尚未收录的模型也能显示和使用，无需硬编码模型 id。

其他提供方仍使用已安装的 `@earendil-works/pi-ai` catalog。要更新它们的目录，升级该依赖并重新构建即可。

catalog 条目声明支持图片输入的模型会接收 DSH 持久化图片附件。纯文本模型会在发送提供方请求前拒绝图片。

<a id="enable-vs-sign-in"></a>
## 开启模型 vs 登录

安装后**默认休眠**：catalog 里有上述订阅，但 **`providers: {}`，不会往模型选择器灌入成百上千个模型**。

| 概念 | 含义 | 怎么做 |
|---|---|---|
| **开启 (enable)** | 向 `llm` 注册路由；模型选择器出现该提供方 | 设置 → **OAuth / 订阅** 点「开启」，或 `/oauth enable xai`，或登录时自动开启 |
| **登录 (login)** | 写入 `pi-ai-oauth.json` 订阅 token | 设置面板「登录」、`/oauth login xai`，或终端 `bin/login.mjs` |
| **关闭 (disable)** | 从选择器移除；**保留**已存 token | 设置面板「关闭」或 `/oauth disable xai` |

只有**已开启**的提供方会出现在聊天模型选择器中。OAuth 开启与登录由设置 → **OAuth / 订阅**管理；第一方提供方配置目录保持不变。

<a id="install"></a>
## 安装

使用此分支的当前 DSH 源码。提供方开启状态使用 Cordis volatile Config 字段，保存在当前 profile 的 `cordis.patch.yml` 中；更改会更新适配器路由，无需重启，也不会更改已保存的登录凭据。同步后在 DSH 检出目录执行：

```sh
pnpm run setup:web
```

设置会构建本地源代码，并将其配置叠加层安装到所选 Web profile。设置前停止此 profile，完成后重启；仅刷新浏览器不会替换正在运行的 Host。每台机器都需单独完成提供方登录。

<a id="settings--oauth--subscriptions"></a>
## 设置 → OAuth / 订阅

Web 端在设置侧栏会多一页 **OAuth / 订阅**（在「模型」与「插件」之间）：

- 列出 catalog 中每个订阅提供方
- 徽章：**已开启 / 未开启**、**已登录 / 未登录**、浏览器登录进行中
- 操作：开启、关闭、登录、退出登录（都在本页点按钮完成，不必在聊天框输入 `/oauth`）
- 登录成功会写入 token，并自动开启
- 设备码显示在页面提示区（可复制）；授权链接会尽量新开标签，弹窗被拦时点 **打开授权页**

`openai-codex` 等需要「选择登录方式」的提供方，Web 端会**自动选设备码**（浏览器回调要本机 `:1455` 端口，设置页用不了）。若仍提示 interactive prompt，再用终端 `bin/login.mjs`。

提供方开启并登录后，其模型会出现在聊天模型选择器中。设置 → **模型**继续负责第一方 API Key 路由配置：

![开启订阅后的设置 → 模型](docs/models.png)

API Key 提供方仍在 **设置 → 模型** 精调。OAuth 的开启与登录在本插件这一页完成。

Host 提供轻量 HTTP API（同机 Web 使用）：

| 方法 | 路径 | Body |
|---|---|---|
| `GET` | `/dsh-llm-oauth/status` | — |
| `POST` | `/dsh-llm-oauth/enable` | `{ "provider": "xai" }` |
| `POST` | `/dsh-llm-oauth/disable` | `{ "provider": "xai" }` |
| `POST` | `/dsh-llm-oauth/login` | `{ "provider": "xai" }` |
| `POST` | `/dsh-llm-oauth/logout` | `{ "provider": "xai" }` |

<a id="chatgpt--codex-enable-device-code-auth-first"></a>
## ChatGPT / Codex：先打开设备码授权

Web 端的 `openai-codex` 走 **设备码**，不用本机 `:1455` 浏览器回调。ChatGPT 默认藏着这个入口，需要先打开：

1. 打开 [ChatGPT → 设置](https://chatgpt.com/)，进入 **应用与连接器**（或当前界面里的 **连接器 / Codex**）。
2. 找到 **Codex**，打开 **为 Codex 启用设备代码授权**。
3. 回到本插件设置页，对 `openai-codex` 点「登录」，再打开授权链接并输入页面上的设备码。

![为 Codex 启用设备代码授权](docs/codex-auth.png)

没开这个开关时，即使用户码是对的，授权页也会拒绝。本插件已经自动选了设备码方式，缺的是 ChatGPT 侧的许可。

**风险：** 用设备码或任何非官方客户端做 Codex / ChatGPT OAuth 登录，可能导致 ChatGPT 账号被限制或封禁。OpenAI 会把这当成在官方 Codex / ChatGPT 应用之外使用订阅。若要试，请用可丢弃的号，不要拿主力号或付不起损失的付费号登录。本插件无法防止或解除封禁。

<a id="login--commands"></a>
## 命令行 / 斜杠命令

启动 Web 后在输入框：

```
/oauth status
/oauth list
/oauth enable xai
/oauth login xai
/oauth disable xai
/oauth logout xai
```

`/oauth login` 会马上返回授权链接和验证码（不会一直转圈）。浏览器里完成登录后再执行 `/oauth status`，或刷新设置页。后台会继续轮询直到登录结束。

凭据写到 `$DSH_HOME/pi-ai-oauth.json`（默认 `~/.dsh/pi-ai-oauth.json`）。

需要终端（或提供方仍要求交互式提问）时：

```sh
node bin/login.mjs --list
node bin/login.mjs xai
```

已安装进 profile 后：

```sh
node %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-llm-oauth\bin\login.mjs xai
```

也可以在 profile 的 `cordis.patch.yml` 里手写：

```yaml
- id: llm-oauth
  config:
    providers:
      xai: {}
```

<a id="do-not-collide-with-llm-pi-ai"></a>
## 不要和 llm-pi-ai 抢同一条路由

`dsh-base` 会挂载休眠的 `dsh-llm-pi-ai`。如果你又在 settings 的 `llm-pi-ai:` 里配置了 `xai` / `github-copilot` 等**相同** provider id，会 `DUPLICATE_ADAPTER`。

- 订阅 / OAuth → 只用本插件
- API Key（DeepSeek、官方 OpenAI API）→ 继续用 `llm-deepseek` / `llm-pi-ai`

<a id="develop"></a>
## 开发

```sh
pnpm install
pnpm test
pnpm run build
node bin/login.mjs --list
```

`@deepseek-ai/*` 是 DSH profile 提供的 peer。配置与 Loader 集成测试需要本机可用的当前 DSH peer；适配器测试模拟 DSH LLM 接口，使用符合服务协议的 HTTP 响应验证 pi-ai，不调用真实模型。

<a id="limits"></a>
## 限制

- Copilot 目录发现需要认证和网络；其他模型列表跟随 `@earendil-works/pi-ai`，本插件不维护私有模型表
- 无完整 native replay 签名
- Web 端没有独立 OAuth 回调服务器（device code / 打开 URL）
- 普通 OpenAI API、DeepSeek 官方仍走 API Key
- 设置 → **模型** 页只精调 API Key（`llm-deepseek` / `llm-pi-ai`）；OAuth 开启与登录在 **设置 → OAuth / 订阅**

<a id="license"></a>
## License

MIT

<a id="dev-note"></a>
## 开发备注

无。
