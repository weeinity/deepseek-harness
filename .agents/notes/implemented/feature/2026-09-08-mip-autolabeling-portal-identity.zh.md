# Agent Note: MIP Autolabeling 门户身份

Status: implemented

[English](2026-09-08-mip-autolabeling-portal-identity.md) | 中文

## 问题

MIP 门户在彼此独立的浏览器与 React 位置展示部署身份。侧栏使用 MIP 标志，而 favicon 与空白 Session Hero 使用鲸鱼标志，会让同一个应用同时呈现两套身份。

## 决策

[`dsh-client-ui-primitives`](../../../../packages/client/ui-primitives/README.zh.md) 中的 `MipAutolabelingMark` 拥有 React 图稿。侧栏回退、空白 Session Hero 回退以及官方品牌的两个标志占位者都渲染这个共享组件；侧栏字标保持为独立占位者，因为 Hero 只需要标志。

[`apps/web/public/favicon.svg`](../../../../apps/web/public/favicon.svg) 以独立 SVG 形式携带相同的已应用标签轮廓、透明勾选符号与金色星芒。浏览器界面与[安装 manifest](2026-08-06-web-install-manifest.zh.md) 在 React 插件图运行前就需要该资产，因此 favicon 保持在 slot 系统之外，并由构建产物测试固定一致的身份。

MIP 调色板属于固定图稿，而不是主题墨色。Hero 保留既有位置和遵循减少动态效果设置的悬停移动；文档标题、构建徽标与安装 manifest 名称仍是独立配置的文本。

## 验证

primitive 测试固定标志的方形尺寸、view box、class 透传、固定填充色与透明勾选符号。侧栏与 Hero 组件测试断言 MIP 回退，官方品牌插件测试断言两个 slot 使用同一个标志组件，无密钥录制生命周期场景检查渲染身份，浏览器启动测试检查悬停移动，Web 构建产物测试固定独立 favicon。

## 曾考虑的替代方案

**在 Hero 与浏览器标签页中保留鲸鱼。** 不予采纳，因为同一个门户会继续呈现两套无关身份。

**在各功能包中复制 React SVG。** 不予采纳，因为侧栏、Hero 与官方构建可能发生漂移；零 Cordis 的 primitive 是品牌标志既有的共享运行时所有者。

**通过 UI slot 驱动 favicon。** 不予采纳，因为浏览器会在 Client Loader 与 React slot 树可用前请求文档元数据，安装 manifest 也需要稳定的资产 URL。

## 后果

门户在浏览器界面、侧栏与空白 Session Hero 中一致呈现 MIP 标志。图稿变更必须同时更新共享 React primitive 与独立 favicon；测试明确固定这项资产层复制。需要其他身份的部署必须替换 slot 占位者，并提供匹配的浏览器元数据。
