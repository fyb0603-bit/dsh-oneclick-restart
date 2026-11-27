# dsh-oneclick-restart

DSH 设置页「重启」分区：**检测运行中对话 → 二次确认 → 一键重启 Host / 桌面应用**。

仓库：https://github.com/fyb0603-bit/dsh-oneclick-restart · 许可：MIT

## 三条硬约束的落点

| 约束 | 实现 |
|---|---|
| 不与现有插件冲突 | loader entry id `oneclick-restart`、路由前缀 `/oneclick-restart`、设置分区 slot id `oneclick-restart`、状态目录 `~/.dsh/oneclick-restart`，全部独占命名。`/oneclick-restart/status` 返回 `plugin: "dsh-oneclick-restart"`；客户端发现标识不符即判定「路由被别的插件抢占」并自锁，不执行重启（webServer 的重名 exact 路由是静默覆盖，没有内建冲突报错）。 |
| 先检测运行中对话 | 宿主从 `ctx.agents` 注册表读 `agent.status === 'running'`（权威源，与 `api-session/status` 同源），status 路由实时返回 id 集合；POST 时再算一次，变化即 409 `stale`。 |
| 重启需二次确认 | 服务端：`body.confirm === "RESTART"`；有运行中对话时还要 `acknowledgeRunning === true` 且 `expectRunningIds` 与此刻 running 集合完全一致。客户端：第一下「重启 DSH」只进入确认态，勾选「我已知晓」后才能点「确认重启」。 |

## 宿主半区路由（lib/index.js）

- `GET /oneclick-restart/status` → `{ plugin, version, bootId, pid, target{mode,pid,exe,workdir}, running[], runningCount, accepted, logTail }`
- `GET /oneclick-restart/token` → 每进程随机 CSRF token（`x-oneclick-restart-token` 头）
- `POST /oneclick-restart/restart` → 202；全部只接受 loopback Host

## 重启通道（lib/restart-app.ps1）

本进程不能自杀式重启：请求通过 `schtasks /create + /run` 拉起**脱离宿主进程树**的 PowerShell，
由它 `CloseMainWindow` → 6s 轮询 → `taskkill /T /F` → 确认目标 pid 与同名进程都消失 → `Start-Process`
→ 自检 → `schtasks /delete`。参数走 `target.json`，避开 schtasks `/tr` 的引号地狱。

目标判定：`process.execPath` 的 basename 为 `DeepSeek Harness.exe` 时重启桌面主进程
（host 子进程用 `process.ppid`，否则用自身 pid）；其他运行时按 host 模式重启自身并复用 `process.argv.slice(1)`。

日志：`~/.dsh/oneclick-restart/restart.log`（客户端卡片里可展开查看）。

## 安装

### 方式 A：直接从 GitHub 装

```bash
dsh plugin --profile desktop add github:fyb0603-bit/dsh-oneclick-restart
```

### 方式 B：本地开发态（link 到本机插件目录）

1. 在 `~/.dsh/profiles/desktop/package.json` 里注册：
   - `dependencies["dsh-oneclick-restart"] = "link:<你的用户目录>/.dsh/plugins/dsh-oneclick-restart"`
   - `dsh.profile.bundles` 追加 `dsh-oneclick-restart`
2. `node_modules/dsh-oneclick-restart` 指向该目录的 junction。
3. 首次生效需重启一次 DSH —— 此后就用插件自己的按钮重启。

## 验证记录

- `lib/restart-app.ps1`：PowerShell 5.1 `Parser::ParseFile` → `PS_PARSE_OK`（文件带 UTF-8 BOM，缺 BOM 会因中文注释解码错位报语法错）。
- 路由 stub 冒烟：status/token 200；无 token 403 `csrf`；`confirm` 缺失 400；有运行中对话且未确认 400 `running-sessions`；id 集合不符 409 `stale`；非 loopback Host 403；GET 打 POST 路由 405。
- 重启器实测：用假目标（node 进程）跑完整链路 → WM_CLOSE 无效后 6s 强杀 → relaunch → 计划任务自动删除，目标进程确实消失。
- `schtasks` 引号链路单独实测：`cmd.exe /d /c launch.cmd` → 计划任务创建/运行/自删全部成功。

## 回滚

从 `~/.dsh/profiles/desktop/package.json` 移除 dependency 与 bundles 条目，删掉 `node_modules/dsh-oneclick-restart` junction，重启一次即可。
