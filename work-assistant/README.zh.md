---
description: "构建并运行单用户 DeepSeek Harness 个人助理 profile。"
kind: "package-group"
---

# DeepSeek 工作助理

[English](README.md) | 中文

<a id="summary"></a>
## Summary

这个 workspace 基于已发布的 `@deepseek-ai/dsh@0.1.5-alpha.2` 构建插件化个人助理 profile。它在 `work-assistant` 下添加已准入的个人日历、记忆、preset、网关和定时简报 bundle；父 checkout 拥有配套 Agent Note。

<a id="contents"></a>
## Contents

- [Prerequisites](#prerequisites)
- [Packages](#packages)
- [Build and test](#build-and-test)
- [Configure a new dedicated profile](#configure-a-new-dedicated-profile)
- [Docker](#docker)
- [Limits](#limits)

<a id="prerequisites"></a>
## Prerequisites

使用 Node 24、pnpm 11.7、Git、新的专用 `DSH_HOME`、专用 workspace、个人日历 `.ics` 文件或 DSH 凭据引用、本地 Git 记忆仓库，以及真实 DSH 模型凭据。不要把 setup 指向现有用户或公司 home，也不要复制旧凭据。

<a id="packages"></a>
## Packages

- [`@deepseek-ai/dsh-wa-gateway`](packages/wa-gateway/README.zh.md)：只准入网关拥有的工具，为写入请求一次性授权，并保存仅含元数据的审计记录。
- [`@deepseek-ai/dsh-wa-calendar`](packages/wa-calendar/README.zh.md)：读取一个已配置的本地 `.ics` 文件或由凭据支持的 HTTPS iCalendar feed。
- [`@deepseek-ai/dsh-wa-memory`](packages/wa-memory/README.zh.md)：把获批 Markdown 笔记保存在一个专用本地 Git 仓库。
- [`@deepseek-ai/dsh-wa-preset`](packages/wa-preset/README.zh.md)：发布 `personal-assistant` persona 资产。
- [`@deepseek-ai/dsh-wa-briefing`](packages/wa-briefing/README.zh.md)：可选地把定时只读简报送入持久化的应用内收件箱。
- [`@deepseek-ai/dsh-wa-ui`](packages/wa-ui/README.zh.md)：显示带主题的助理侧栏，包含会话、待处理事项以及已记录的日历和记忆结果。

<a id="build-and-test"></a>
## Build and test

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:profile
```

`patches/` 中的 pnpm 补丁为锁定版本的共享 Chat 软件包添加回执槽位。`pnpm run build:receipt-runtime` 将这些已打补丁的软件包打包，供 profile 本地安装；不会更改主 DSH 安装。

如需针对性验证主动功能，请在此 workspace 运行以下命令。profile 冒烟测试重放[规范录制 Session](../snapshots/web/work-assistant-proactive/snapshot.yml)，验证隔离的浏览器及 profile 更新，并保留诊断信息。覆盖率命令执行逐文件 100% 阈值，并在失败时报告缺口；单元测试通过本身不表示覆盖率通过。

```powershell
pnpm run test:profile -- --proactive --keep
pnpm exec vitest run --config vitest.proactive.config.ts --coverage --coverage.reportOnFailure
```

<a id="configure-a-new-dedicated-profile"></a>
## Configure a new dedicated profile

setup 脚本会拒绝冲突 profile，并且只写入传入的日历引用、记忆根目录、模型路由、preset 资产和 profile 文件。它接受 `pnpm run setup:profile` 后的一个包管理器分隔符，并拒绝未知、重复或互斥选项。

新 profile 仅为 `personal-assistant` 启用[由助理选择的确认表情回应](packages/wa-ui/README.zh.md#acknowledgement-reactions)。单独的竖拇指回复可以显示在用户气泡上；普通回答不会自动获得标记。表情回应不授予审批，也不证明工作已完成。将 `wa-ui.config.receipt.style` 设为 `neutral` 可显示文字，设为 `off` 可保留普通表情回复。

使用相同输入重新运行 setup 会安装缺失的必需 bundle，但不升级已安装 bundle。使用相同的原始输入并添加 `--update`，可明确重建并重新安装助理 bundle。两种路径都保留现有 profile 补丁、preset 文件、已保存的收件箱和暂停状态，以及无关归档；不会启用计划，也不会替换自定义 persona。更新后请重启原 profile 并刷新其原 URL；启动另一个服务器不会更新它。

```powershell
$assistantHome = 'C:\dsh-personal-home'
$assistantWorkspace = 'C:\dsh-personal-workspace'
$assistantMemory = Join-Path $assistantWorkspace 'memory'
$assistantCalendar = Join-Path $assistantWorkspace 'calendar.ics'
New-Item -ItemType Directory -Force $assistantWorkspace, $assistantMemory | Out-Null
# Place your exported personal .ics file at $assistantCalendar before setup.
git -C $assistantMemory init -b main
git -C $assistantMemory -c commit.gpgSign=false -c user.name='Personal Assistant' -c user.email='assistant@example.invalid' commit --allow-empty --no-verify -m 'initial memory root'
pnpm run setup:profile -- --home $assistantHome --profile personal-assistant --workspace $assistantWorkspace --owner-id personal --calendar-file $assistantCalendar --memory-root $assistantMemory --provider deepseek-official --model deepseek-v4-flash --time-zone America/Los_Angeles
$env:DSH_HOME = $assistantHome
.\node_modules\.bin\dsh.cmd --profile personal-assistant --no-open --host 127.0.0.1 --port 3081
```

当日历源是保存在 DSH 凭据中的 HTTPS feed 时，使用 `--calendar-feed-credential-ref <ref>` 替代 `--calendar-file`。只有需要本地进程运行定时简报时才添加 `--enable-schedule --cron '0 9 * * *'`；默认关闭。如需合成夹具，添加 `--demo-fixture`；生成的事件仅用于演示，不是用户日程。

收件箱在重新连接或重启后仍显示已验证的定时回复。暂停会取消进行中的准备并持久化；恢复只允许未来触发，不补跑错过的时刻。已读、忽略和打开并回复都是明确操作，不授权连接器写入。助理面板关闭时，侧边栏未读标记仍可见。参见[简报策略与保留](packages/wa-briefing/README.zh.md#inbox-and-pause)。

<a id="docker"></a>
## Docker

Docker 是可选项，且本机没有 Docker 可供验证。已检查的构件使用 Node 24，以 UID 10001 运行，只挂载专用 DSH home 和 workspace，把记忆保存在 `/workspace/memory`，从 `/workspace/calendar.ics` 读取本地日历，丢弃 Linux capability，并通过 Compose 在宿主 `127.0.0.1:3081` 发布到容器端口 `3080`。

```powershell
New-Item -ItemType Directory -Force .\data\dsh-home, .\workspace | Out-Null
# Put calendar.ics in .\workspace and ensure .\data\dsh-home plus .\workspace are writable by container UID 10001.
$env:WA_PROVIDER = 'deepseek-official'
$env:WA_MODEL = 'deepseek-v4-flash'
$env:WA_TIME_ZONE = 'America/Los_Angeles'
docker compose -f deployment\compose.yaml up --build
```

持久 home 重启时，entrypoint 只会在已保存 setup 输入匹配时复用受管 profile。可写 workspace volume 允许非 root 进程创建 `/workspace/memory`；如果宿主拒绝 UID 10001 写入，请在启动容器前修正挂载所有权或使用 Docker 托管 volume。

<a id="limits"></a>
## Limits

此助理只用于一个用户的个人数据。它不写日历、不发送邮件、不在 DSH 外部通知、不支持多租户、不隔离同一 profile 中的恶意插件，也不能在没有真实 DSH 模型凭据时工作。定时运行是进程本地能力，会跳过错过的发生时刻，并且不提供跨进程 exactly-once 保证。
