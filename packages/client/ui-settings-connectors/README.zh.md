---
description: "在 Web 设置中搜索已配置的 MCP 连接器，并持久更改其启用状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-connectors

[English](README.md) | 中文

## 概述

打开**设置 → 连接器**，查找当前 DSH 配置方案中的 MCP 服务器并启用或禁用它们。搜索按服务器名称、条目标识符和传输类型筛选同一个列表。每个连接器都有身份图标和启用开关，切换时条目保持原位。更改会等待 Host 确认；失败会明确显示，不会呈现为成功。页面随当前语言以及浅色或深色主题变化。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完善工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[Web 配置叠加层](../../bundle/web-app/README.zh.md)将此页面挂载到设置导航中。页面列出已配置的全局 MCP 条目，包括已禁用条目，但不列出各 Agent 预设中的实例，也不安装新服务器。

在**搜索连接器**中输入文本可筛选列表。无论启用状态如何，条目都保留配置中的顺序。**刷新连接器**读取当前 Host 状态；没有搜索结果与配置方案中没有连接器是不同的状态。

使用连接器开关可持久更改其启用状态。写入期间其他开关保持禁用。如果配置同时在其他位置更改，Host 会拒绝过期写入；请刷新后重试。如果保存成功但激活失败，页面会说明两者的区别，并提示检查配置和重启 DSH。

**已启用**表示插件启用状态，不代表 MCP 握手成功。正在启动、等待、停止、失败和未观察到的 Loader 状态会分别显示。不支持的目标、更高优先级覆盖以及不可写环境会禁用开关，并显示锁图标和原因；写入期间禁用的开关不显示锁图标。

Teams 等已知名称使用服务标志或彩色图形；未知名称使用大写首字母，空白名称使用插头。图标颜色不随启用状态或失败状态变化。传输类型保留在副标题中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

浏览器注册一个按需加载的 `settings.section` 条目，并通过 [Host 连接器 API](../../host/plugin-inventory/README.zh.md)发送范围受限的命令。页面保留最近读取的快照，在本地筛选，并使用返回的修订号进行写入。迟到的响应不能覆盖较新的读取结果，也不能更新已卸载页面。

只有允许公开的连接器元数据会到达页面。页面既不读取连接凭据，也不下载远程图标 URL。共享的 [UI 原语](../ui-primitives/README.zh.md)提供导航图形、搜索框和开关。

`ConnectorMark` 通过不区分大小写的名称映射，选择打包的标志或使用[主题持有](../ui-theme/README.zh.md)颜色的 Phosphor 实心 SVG。标志图像经过裁剪、等比缩放和居中，以 102px PNG data URL 存于 `connector-logos.ts`；打开设置不会发起图片 HTTP 请求。所有装饰性图块均为 34px、圆角为 9px，应用持有的覆盖资源也不例外。中性后备图标跟随主题；名称仍是无障碍身份标识。

此包不发布运行时不变量伴随入口：页面只拥有本地展示状态；持久化、目标授权和配置应用由 Host 负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [MCP 客户端](../../mcp/mcp-client/README.zh.md)——服务器配置和工具生命周期。
- [设置基础包](../ui-settings/README.zh.md)——页面贡献与设置服务。
- [设置外壳](../ui-settings-general/README.zh.md)——导航、对话框和主题组合。

-----

<a id="model-experience"></a>
## 模型体验

通过 [MCP 客户端](../../mcp/mcp-client/README.zh.md)间接影响模型；Host 应用启用状态更改时，工具注册由该客户端负责。

#### KV Cache 影响

启用或禁用服务器会改变后续请求可用的工具定义。提供商的缓存复用不由此页面控制。

## 已知限制与待完善工作

<a id="known-limitations-and-deferred-work"></a>

页面管理配置，不管理服务器安装或传输健康。

- 目录在打开页面、手动刷新和成功写入时刷新；它不是实时 MCP 健康监视器。
- 只显示已配置的全局 MCP 服务器。添加服务器和编辑凭据仍通过配置完成。
- 不支持可写配置方案控制的 Host 仅提供只读元数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
