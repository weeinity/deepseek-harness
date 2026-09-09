---
description: "原生 Web 任务看板：与 DSH 会话和实时执行状态关联的持久化五列工作区看板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-taskboard

[English](README.md) | 中文

## 概述

本包在 DSH Web GUI 中渲染原生任务看板模式。它向侧栏底部贡献入口，并提供保留标准侧栏的全高主表面。卡片来自宿主权威的 Taskboard Client 服务，持久保存工作区状态与顺序，并可关联 DSH Session。运行中的 Session、后台任务和被阻塞的 Goal 只装饰卡片，不改变其持久状态。

## 目录

- [使用本包](#use-this-package)
- [关联现有 Copilot CLI 会话](#associate-an-existing-copilot-cli-session)
- [使用 Agency Copilot 开始任务](#start-a-task-with-agency-copilot)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在 Web profile 中挂载 Taskboard domain、Taskboard Controller 与本客户端插件。从侧栏打开**任务看板**，使用看板顶部的**新建任务**。紧凑的创建对话框包含必填的标题、可选的描述、工作区与可选的 Copilot CLI 会话；**创建**保存任务并打开居中的详情对话框。点击卡片也会打开同一详情对话框，其中包含可编辑的标题、描述、优先级与标签、关联 Session、状态控件、归档和删除操作。创建后工作区保持只读。

卡片显示描述预览、更新时间，以及显式的积压、待办、进行中、审核中或已完成状态。实时 DSH 活动与最新 Agency 观察结果单独显示；空闲的 Copilot 终端不会把任务标记为已完成。拖动或详情中的状态控件会改变计划状态。

在任务详情中选择**归档**，将卡片移出活动看板。**已归档 (数量)** 打开全宽列表，并沿用搜索与工作区筛选；**返回看板**回到各列而不清除筛选。归档详情为只读，并保留打开现有 DSH Session 的导航。归档来自持久化宿主记录，刷新后仍然保留。

在活动或已归档任务详情中选择**删除**，再确认即可永久移除 Taskboard 记录。关联的 DSH 和 Copilot 会话及运行中的终端不受影响。提交前，**取消**、关闭或 Escape 会返回未更改的草稿；删除失败时，确认对话框保留并显示错误，允许显式重试。

本看板以 Dashi Taskboard 的本地优先 issue board 交互作为产品参考。本实现是原生 DSH 代码，不 vendoring 上游源代码。Dashi Taskboard 使用 Apache-2.0 许可证：<https://github.com/chuspeeism/dashi-taskboard>。

<a id="associate-an-existing-copilot-cli-session"></a>
## 关联现有 Copilot CLI 会话

在**新建任务**中选择工作区，再选择现有的 **Copilot CLI 会话（可选）**，然后选择**创建**。选择器显示该工作区的本地会话，包括摘要、标识前缀与当前占用状态。切换工作区会清除选择。**刷新会话列表**重新执行发现；发现不可用或未完成时会明确显示。

要更改已保存的关联，打开任务，选择另一个 Copilot CLI 会话，然后选择**保存**。选择**不关联会话**并保存即可清除关联。任务内容与所选关联一起保存；宿主验证失败时保留草稿，并在对话框内显示错误。发现不可用时，现有关联仍然可见；未更改的关联不会阻止编辑任务信息。

关联在重新加载后仍然保留，并与原生 DSH Session 关联保持独立。选择、保存或清除现有关联不会启动终端、重新发送任务指令，也不会改变计划状态。使用下方终端操作前，请先保存更改后的选择。

<a id="start-a-task-with-agency-copilot"></a>
## 使用 Agency Copilot 开始任务

1. 先把仓库目录注册为 DSH Workspace，并在该 Workspace 下创建任务。Copilot 终端始终从任务 Workspace 启动；任务不会被隐式改派。
2. 打开任务卡片，在 **Agency Copilot 终端** 下选择 **使用 Copilot 开始**。宿主生成新 UUID，与任何 DSH Session 关联独立存储，并启动交互式 Copilot 终端，把任务标题和描述作为首条消息提交。正常的 Agency Workspace 配置与工具审批仍然适用。
3. 关联与启动交接成功后，任务移动到**进行中**。关闭 DSH 不会有意接管或停止用户终端。
4. 使用**刷新状态**观察 **Copilot 运行中**、**可恢复**或诊断状态。**Copilot 运行中**表示 CLI 已取得会话，不代表模型请求正在执行。**打开/恢复 Copilot**恢复空闲会话而不再次提交任务；已运行标识绝不重复启动。
5. **取消关联**只删除任务看板标识，绝不会终止 Copilot。原生**开始工作/打开会话**仍是独立的 DSH 对话流程，可与 Copilot 同时关联到同一任务。

启动控件只在本机 DSH 页面启用。浏览器从不提供 executable path、命令参数、环境值或工作目录。选择现有会话时提供标识供宿主验证；新建启动始终使用宿主生成的 UUID。

<a id="understand-the-implementation"></a>
## 理解实现

插件填充 layout 拥有的 keyed `main.surface` 单元 `taskboard`，并向 additive `sidebar.footer.action` 行贡献入口。两个注册共享 Client Taskboard observable，但使用各自最小化的 inject face。筛选、搜索、所选任务和对话框草稿等纯视图状态保留在 React 本地；业务任务保留在 controller 的无 React Client model 中。

打开任务看板时，Conversation 与右侧栏被遮蔽而非卸载。AppFrame 保留它们的面板偏好，并传入 `active:false` 以暂停 document 级附件行为与右侧栏 portal。显式 Session 导航先打开 Session，再关闭任务看板。

不发布运行时不变式伴生入口：本插件渲染 Controller 的权威任务快照，只持有本地查看状态；它没有需要核对的独立事件流。

<a id="model-experience"></a>
## 模型体验

### Taskboard 展示

#### 模型看到什么

无。本插件为人类渲染 Taskboard 状态，不注册工具、prompt 或模型可见 Session event。

#### Token 影响

每次请求零直接 token。

#### KV Cache 影响

无；浏览器展示状态不进入提供方请求。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 任务看板状态是显式状态；实时 Session、Job、Goal 与 Subagent 状态不会自动完成任务。
- 拖动支持跨列与放到卡片前；键盘排序延期处理。
- 评论、附件、GitHub/Linear 同步与多人云协作延期处理。
- Copilot 启动/恢复是可见的 Windows Terminal 交接，不会导入 transcript 或提供浏览器控制；状态刷新观察 Agency 的本地会话存储。
- 此视图不能恢复、编辑或运行已归档任务。原生任务看板不提供定时调度、权限选择器或逐次执行历史。
- 打开时焦点进入看板；完整焦点陷阱与关闭后恢复侧栏入口属于后续无障碍工作。

<a id="dev-note"></a>
### 开发备注

无。
