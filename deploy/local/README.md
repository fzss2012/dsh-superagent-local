# deploy/local — dsh-superagent-local 部署脚手架

本目录是 `dsh-superagent-local`（去掉 GitHub、只服务**本地项目**的单用户飞书工单 agent）的
部署脚手架，对应 profile `superagent-local`、面板 `127.0.0.1:3084`、门户 `/dsh5/`。
所有文件都只是**示例/模板**：真正部署时按 `setup.md` 复制到 `$DSH_HOME/profiles/superagent-local/`、
`/etc/systemd/system/` 等位置。

## 文件

| 文件 | 用途 |
| --- | --- |
| `profile.cordis.patch.yml` | profile 补丁示例：webserver 3084、`dsh-superagent` 的 `stateDir` + `projects`（git/copy 各一个示例）、启用 `dsh-superagent-feishu`、opencode-go 模型、`agent-default-model`、门户 `connection` 信任 |
| `dsh-superagent-local.service` | systemd unit：`dsh superagent-local --no-open`，`User=ubuntu`，`DSH_HOME=/home/ubuntu/.dsh`，自动重启 |
| `fake-lark-cli.sh` | 离线 E2E 用的假 lark-cli（可执行）：实现 dsh-superagent 实际调用的 auth/config/bot info/im 命令、事件消费、回复记录 |
| `setup.md` | **操作手册（先读这个）**：前置条件、建 profile、本地项目、飞书自建应用权限/事件/发布、bot-only lark-cli + wrapper、systemd、门户 `/dsh5/`、验收、假 CLI 冒烟测试、排障 |
| `README.md` | 本文件 |

## 最短路径

1. 读 `setup.md` 第 2-4 节（第 1-3 步）：`pnpm build`、建 `superagent-local` profile、装 bundle、写 profile 配置。
2. 复制 `profile.cordis.patch.yml` 到 `~/.dsh/profiles/superagent-local/cordis.patch.yml`，替换 `oc_REPLACE` 等占位符。
3. 准备本地项目目录（git 模式要有 `git init` + 至少一个提交）。
4. 按 `setup.md` 第 6-7 节（第 5-6 步）在飞书控制台建应用、配权限/长连接事件/发布/进群，并配好 bot-only lark-cli + `~/.local/bin/lark-bot-local`。
5. 安装 systemd unit 并启动；在面板配置 Feishu Source / Policy / Execution。
6. 按 `setup.md` 第 10-11 节（第 9-10 步）挂门户 `/dsh5/`（root）并验收。

## 仍然必须由操作者完成的事（无法脚本化）

- **飞书开放平台控制台**：创建企业自建应用、添加机器人能力、申请权限、配置「长连接」事件订阅
  `im.message.receive_v1`、创建并发布版本、设置可用范围、把机器人拉进目标群。
  控制台页面/权限名可能随飞书版本变化，需按官方文档核对。
- **真实凭据**：App ID / App Secret 的申请与保管；`lark-cli config init` 与 `strict-mode bot` 的确认
  （本文档给出命令，但 secret 只能由操作者输入）。
- **root 操作**：安装 systemd unit、编辑 `/etc/dsh-portal/backends.json`、签发并写入
  `/etc/dsh-portal/cookies/sa-local.cookie`、执行 `sudo dsh-portal-refresh`。
  本脚手架不运行任何特权命令；门户模式说明见 `setup.md` 第 10 节（第 9 步）。
- **首次业务配置**：面板里 Feishu Source 的 Chats/私聊开关、Policy 的 allowed 名单/admission、
  Eval 的 accept mode、Execution 的 maxWorkers/模型——这些写入 `stateDir` 数据库，不能预置。
- **真实 @ 验收**：用允许名单账号在群里 @机器人，确认工单创建、执行、回复闭环。

## 约定与假设

- 与现有 `superagent` 实例**共用** `DSH_HOME=/home/ubuntu/.dsh`，因此模型 key 引用
  `OPENCODE_GO_API_KEY`（`~/.dsh/.credentials.yaml` 的 refs）通常已可用；但 profile、stateDir、端口、
  飞书应用、lark-cli 配置目录**全部独立**，互不影响。
- 新实例端口 `3084`、stateDir `/home/ubuntu/.dsh/state/superagent-local`、门户路径 `/dsh5/`、
  cookie 文件 `/etc/dsh-portal/cookies/sa-local.cookie`（门户 authority 为 `dsh.example.com`）。
- 本地项目通过 profile 的 `projects` 配置；Feishu Source/Policy/Execution 通过面板或管理 API 配置。
- 假 lark-cli 只用于冒烟/回归，不能替代真实飞书应用验收；其契约已用独立脚本自测，并已在临时 profile +
  完整 dsh-superagent 实例上验证 setup/事件消费/Trigger 入库（2026-11-08）。完整步骤见 `setup.md` 第 12 节。
- **完整的假 CLI 端到端验收报告见 [e2e-report.md](e2e-report.md)**：git/copy 两种项目模式、工单创建、附件回复、应用（merge/sync）、状态命令、重启恢复均已跑通；真实飞书仍须按 `setup.md` 完成应用创建后验收。
