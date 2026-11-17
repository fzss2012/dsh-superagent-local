# Windows 部署（本机实例 · 门户 /dsh6/）

本文件记录 **Windows 单机实例** 的实际部署方式，与 [setup.md](../setup.md)（Linux/systemd/门户 /dsh5/）
互补。示例值取自本机：profile `superagent-local`、面板 `127.0.0.1:3084`、门户 `https://<host>/dsh6/`。

> 与 Linux 的差别只有三处：**进程管理用启动脚本而不是 systemd**；**git 模式需要 Windows 路径处理**；
> **门户 cookie 的有效期上限必须在 profile 中放开**（见第 3 节，这是最容易踩的坑）。

## 1. 前置

| 项 | 要求 |
| --- | --- |
| DSH | `dsh --version` 可用（安装版即可，CLI 位于 `...\resources\runtime\cli\bin\dsh.cmd`） |
| Node / pnpm | Node 22.19+ 或 24+；pnpm（用于 `pnpm install` 与 `pnpm build`） |
| git | 2.32+（git 模式项目需要 worktree 支持） |
| 构建产物 | **本仓库以 `link:` 方式装入 profile，必须先在源码目录 `pnpm build` 出 `lib/`**；改过 `src/` 后要重新 build 并重启实例 |

```powershell
cd D:\dsh-superagent-local
pnpm install
pnpm build
```

## 2. 创建 profile 并装入 bundle

```powershell
dsh superagent-local --from-default-profile web --dump-config > $null
dsh plugin --profile superagent-local add link:D:/dsh-superagent-local
dsh plugin --profile superagent-local list
```

`package.json` 的 `dsh.profile.bundles` 应含 `dsh-base`、`dsh-web-app`、`dsh-superagent`。

## 3. profile 配置（`%USERPROFILE%\.dsh\profiles\superagent-local\cordis.patch.yml`）

只需机器级配置；Feishu Source / Policy / Execution 写在 `stateDir` 的数据库里，通过面板修改。

```yaml
- id: webserver
  config: { host: 127.0.0.1, port: 3084 }

- id: dsh-superagent
  config:
    stateDir: "C:/Users/<user>/.dsh/state/superagent-local"   # 必须绝对路径，且不能与别的实例共用
    projects:
      - name: bd-dist
        path: "Y:/dist"      # 非 git 仓库 → copy 模式
        mode: copy

- id: dsh-superagent-feishu
  disabled: false
```

### 门户访问必须加的一段（否则 /dshX/ 报 401）

nginx 反代会 `proxy_set_header Cookie` 注入一枚**长效**签名会话 cookie。实例默认
`cookieMaxAgeDays = 30`，364 天的 cookie 会被判过期，页面显示
`dsh web authentication required; reopen the URL printed by dsh web.`

```yaml
- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  config:
    trustedHosts:
      - <门户域名>
    cookieMaxAgeDays: 365     # 必须 >= 门户签发 cookie 的有效期
```

改完先做纯配置校验，再启动：

```powershell
dsh superagent-local --dump-config > $null
```

## 4. 启动 / 停止 / 重启

用 [windows/superagent-local.ps1](windows/superagent-local.ps1)（本目录提供）：

```powershell
.\superagent-local.ps1 status
.\superagent-local.ps1 start
.\superagent-local.ps1 restart
```

**重启为什么要等 32 秒**：`Runtime` 用 `proper-lockfile` 以 `stale: 30_000` 锁住 `stateDir`。
杀掉进程后立刻启动，新进程会在 `lockSync` 处抛 `Lock file is already being held`，插件不激活
（表现为面板起得来但 `/orchestrator/api/*` 全部 404）。脚本因此在 stop 与 start 之间等待超过 stale 窗口。

**开机自启**：在启动文件夹放一个隐藏窗口的 `.vbs`（登录时触发）：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\dsh-superagent-local\deploy\local\windows\superagent-local.ps1"" start", 0, False
```

## 5. 反向隧道（把本机面板发布到门户）

```powershell
ssh -i <key> -N -R 127.0.0.1:<remote-port>:127.0.0.1:3084 -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o BatchMode=yes ubuntu@<host>
```

面板端口必须与 `webserver.port` 一致（本机 3084）。常驻建议用 supervisor 脚本 + 启动项，
断线自动重连，并在本机面板端口消失时重建隧道。

## 6. 飞书 bot 专用 CLI

Executors 以 `lark-cli` 的名义调用它，Host 启动时会拒绝「仍能以用户身份行事」的 CLI。因此需要
**独立配置目录 + strict mode bot + wrapper**：

```powershell
$env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.dsh\lark-cli-<instance>"
lark-cli config init --app-id cli_xxx --app-secret-stdin --brand feishu
lark-cli config strict-mode bot --global
```

wrapper 是一个把 `LARKSUITE_CLI_CONFIG_DIR` 注入环境后再调用 `lark-cli.exe` 的小程序（本机用 C# 编译）。
在面板的 Feishu Source 里填它的绝对路径。

## 7. 验收

```powershell
# 面板
curl.exe -s -H "x-orchestrator-request: 1" http://127.0.0.1:3084/orchestrator/api/state
# 门户（需要 basic 凭据与门户域名，详见门户侧配置）
curl.exe -k -o NUL -w "%{http_code}" -u '<user>:<pass>' https://<host>/dsh6/
```

`state` 返回的 `health` 全部 `ready` 才算正常；`feishu` 为 `error` 表示事件消费者已退出（多为
DNS/网络抖动后未能重连），重启实例即可恢复，与门户无关。

## 8. 排障

| 现象 | 原因与处理 |
| --- | --- |
| 面板起来但 API 全 404，日志有 `Lock file is already being held` | 上一进程刚被杀，锁未过 stale 窗口；等 30 秒以上再启动 |
| 门户页显示 `dsh web authentication required` | profile 缺 `connection.cookieMaxAgeDays`（或小于门户 cookie 有效期） |
| `/dshX/orchestrator/api/...` 返回 403 | 该前缀强制 `Host: <门户域名>`，而实例 same-origin 只认 `Host: 127.0.0.1:<port>`；改走门户根路径 `/orchestrator/api/...` + `Referer` |
| 群里发消息没反应 | 看 `health.feishu`；同时确认群在 Source 的 Chats 内、发送者在 Policy 的 allowed 内 |
| `projectMissing` / `projectNotGit` | profile 的 `projects[].path` 不存在，或 git 模式目录不是工作树 |
