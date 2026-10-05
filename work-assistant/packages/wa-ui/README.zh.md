---
description: "在聊天旁展示助理上下文，并显示由模型偶尔选择的确认表情回应。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-wa-ui

[English](README.md) | 中文

## 概述

在 Nocturne 浅色和深色布局中，把会话、待处理事项以及已记录的日历和记忆结果放在聊天旁。个人助理 setup 包含此 bundle；其他 profile 保留现有布局，除非也安装它。日历和记忆快捷按钮会复制建议请求，供你粘贴到普通聊天中并发送。助理可以偶尔用表情回应消息，而不另发文字回复。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 安装到配置

包清单声明 `dsh.bundle.patch`，补丁为 `@deepseek-ai/dsh-wa-ui` 插入一个 `wa-ui` Cordis 行。work-assistant 装配流程负责把这个私有包与个人助理配置的其他包一起打包和安装。不要手动添加第二个配置行；该包需要该配置中已经存在的已发布 Web Client 服务。

### 获得的行为

右侧面板显示 Harness 身份和五个支持键盘操作的标签页。时间线打开最近的非空个人助理会话。队列显示待处理交互和运行中的会话；查看按钮打开现有交互界面，不会批准请求。日程和记忆显示所选会话已加载历史中的已记录工具结果，不是实时日历或全局记忆清单。

使用面板右上角按钮关闭它，使用侧边栏的 `显示助理面板` 控件重新打开。紧凑左栏保留 DSH 导航。主题 token 遵循现有浅色和深色偏好。主会话、输入框、模型选择和审批仍由 DSH 拥有。

`已连接到 DSH` 表示浏览器与 DSH 的连接，而不是 Copilot 登录或日历可用性。会话行表示已保存的会话，不是推断出的已完成任务。

在 `wa-ui` 行把 `maxActivities` 设为 1 到 20，可更改每个有限行数会话区域的默认六行。将 `defaultTab` 设为 `timeline`、`queue`、`day`、`memory` 或 `inbox`；默认值为 `timeline`。Host 加载配置变更后，请刷新页面。查看状态保留在浏览器中；该 bundle 不扫描其他会话，也不建立活动数据库。

### 主动收件箱

收件箱显示[简报服务](../wa-briefing/README.zh.md#inbox-and-pause)保存的消息。即使面板关闭，侧边栏标记也显示未读消息；面板标题在每个标签页预览最新未读消息。两者都不会自动改变焦点或当前对话。打开并回复会将项目标为已读并打开其普通对话，不发送输入或覆盖草稿。标为已读和忽略操作跨重启保留。暂停会取消进行中的准备并持久化；恢复只允许未来已配置的发生时刻。界面不能启用简报计划被禁用的部署。

浏览器在挂载、重新连接、明确刷新时以及每隔 `inboxRefreshIntervalMs`（默认 15000，范围 1000–300000）读取同源收件箱。`inboxRequestTimeoutMs` 限制每个请求及响应体的时长（默认 10000，范围 100–120000）。请求失败时显示错误并保留上次验证的快照；不会显示乐观的动作成功状态。轮询不会创建模型工作。不提供浏览器推送或外部通知。

<a id="acknowledgement-reactions"></a>
### 确认表情回应

可选的 `receipt` 配置要求明确提供 `presetIds`，以及值为 `thumbs-up`、`neutral` 或 `off` 的 `style`。空、重复或带首尾空白的预设 ID 会被拒绝。省略 `receipt`、将其设为 `null` 或选择 `off` 时，助理回复保留在普通对话中。启用表情回应需要共享 Chat 的 `conversation.chat.user-badges` 扩展；未打补丁的已发布 Chat 包不足以支持它。

```yaml
receipt:
  presetIds: [personal-assistant]
  style: thumbs-up
```

当助理选择仅用竖拇指回复时，符合条件的用户消息在右下边缘显示圆角表情回应标记，标签为 `助理用表情回应了你的消息。`。标记在 Chat 中替代单独的表情回复，并与用户消息的复制文字及复制和时间控件保持独立。中性样式显示 `已收到`。资格取决于所选 Session 已解析的预设，以及可信的 Web 入口来源。回应身份跟随精确的用户和助理消息 ID，而不是匹配文字。

表情回应是助理的对话选择，不是送达或已读回执。普通文字回复、表情与文字混合的回复、乐观发送回显、排队输入，以及未完成或已取消的回复都不产生表情回应。普通助理回复保留在持久日志中；重新打开历史不会增加模型调用或确认事件。禁用此展示会恢复普通表情回复，不改写日志。表情回应不授予审批，也不证明工作已完成。现有助理回复反馈控件保持独立。

### 已记录结果和快捷请求

日程和记忆需要日历和记忆 bundle 提供带版本的展示元数据。缺失、不支持、格式错误、失败和截断结果都会明确显示。记忆写入回执不包含笔记预览；修订变化、写入失败或完整清单中缺少某笔记都会使旧预览失效。截断清单不能证明未列出的笔记已被删除。

`复制日历请求` 和 `复制记忆请求` 使用浏览器剪贴板，不会导航、修改现有草稿或发送输入。请在普通输入框中粘贴并检查请求；工作区和模型要求仍然适用。如果复制失败，请选中显示的请求文字并手动复制。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部 — 点击展开</summary>

[Host 注册](src/index.ts) 通过 Web 服务器的结构化全局注入，仅发布经过验证的展示设置。浏览器验证此页面局部值；缺少 Host 配置会使启动失败，而不是静默禁用已配置的回执。[Client 注册](src/client/index.ts) 通过 Cordis effect 持有语言字典、主题覆盖、CSS 和槽位替换。

严格 Session 标题桥接器将已加载的聊天视图发布到根作用域拥有的 observable；右栏只在其 Session 与所选会话匹配时读取它。根槽位与 Session 槽位不共享 StoreDefinition。`cordis.patch.yml` 只插入 `wa-ui` 行。

该包不发布 `./invariant`。它拥有的事实是槽位注册、组件渲染、本地 UI 状态以及直接读取的收件箱快照；没有独立运行时资源、持久格式或跨进程关系需要 invariant installer 比较。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [补丁文档](cordis.patch.yml)
- [Client 注册](src/client/index.ts)
- [面板组件](src/client/AssistantPanel.tsx)
- [组件测试](tests/assistant-panel.client.spec.tsx)

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器 UI 渲染

#### 模型看到的内容

打开标签页或复制请求不会向模型发送任何内容。该 bundle 不注册工具、提示词贡献或模型请求元数据。如果你粘贴并发送建议请求，它会成为普通的已记录用户输入。英文建议如下：

- `Show my calendar for today. Use an explicit local time window and summarize conflicts only if the calendar data shows them.`
- `Help me add one personal memory note. Ask me which single note to save before writing.`

#### Token 影响

查看和复制没有直接 token 影响。明确发送的建议消耗普通用户输入 token。

除助理的普通回复外，表情回应展示不增加模型请求或 token，也不授权工具。可选表情回复指导和人类提问工具属于[个人助理预设](../wa-preset/README.zh.md)，而不是此 UI 入口。

#### KV Cache 影响

该 bundle 不修改模型请求字段。明确发送的建议具有新用户输入的普通缓存影响。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **文件和资源预览** — 助理面板替换原生文件和资源停靠展示及其标题控件。不要在需要这些预览面板的 profile 中安装此 bundle。
- **面板宽度** — DSH 拥有默认宽度和拖动调节器。该 bundle 无法设置 340px 默认值；调整后的宽度不会跨页面刷新保留。
- **已记录数据** — 日历和记忆行可能不完整或过时。它们描述已加载的记录结果，而不是当前外部状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
