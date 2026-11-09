# dsh-superagent-local 部署与运维手册（单用户 · 本地项目 · 飞书工单）

> 适用对象：在**本机**再跑一个 dsh-superagent 实例，只服务**本地项目目录**（不再依赖 GitHub），
> 通过**新建的飞书自建应用/机器人**接收工单。目标 profile 名 `superagent-local`，面板 `127.0.0.1:3084`，
> 门户路径 `/dsh5/`。
>
> 本目录只放**部署脚手架**（profile 示例、systemd unit、假 lark-cli、本文档）。
> 飞书开放平台建应用、申请权限、发布版本、把机器人拉进群等控制台操作**无法脚本化**，必须人工完成（见第 5 步）。
>
> 与现有实例的关系：现有 `superagent`（`/home/ubuntu/dsh-superagent`，profile `superagent`，3082，`/dsh3/`）
> **保持不动**；新实例用独立的 profile、stateDir、端口、飞书应用和 lark-cli 配置目录，两者互不影响。

## 0. 目标形态

| 项 | 现有实例（不要动） | 新实例（本文） |
| --- | --- | --- |
| 代码 | `/home/ubuntu/dsh-superagent` | `/home/ubuntu/dsh-superagent-local`（本 fork，已去掉 GitHub） |
| profile | `superagent` | `superagent-local` |
| 面板 | `127.0.0.1:3082` | `127.0.0.1:3084` |
| stateDir | `/home/ubuntu/.dsh/state/superagent` | `/home/ubuntu/.dsh/state/superagent-local` |
| systemd | `dsh-superagent.service` | `dsh-superagent-local.service` |
| 飞书应用/bot | 现有 app `cli_example0000000000000000` | **新建**自建应用（不同 app id、独立 lark-cli 配置目录） |
| lark-cli 配置 | `~/.lark-cli-dsh-superagent` | `~/.lark-cli-superagent-local` |
| bot wrapper | `~/.local/bin/lark-bot` | `~/.local/bin/lark-bot-local` |
| 门户 | `/dsh3/` -> 3082 | `/dsh5/` -> 3084，cookie 文件 `/etc/dsh-portal/cookies/sa-local.cookie` |

工作流：飞书消息/事件 -> Feishu Source -> Trigger/Thread -> Gate/Eval -> Ticket（工单）-> 每个工单一个
Executor Session 在**本地项目**的 worktree（git 模式）或副本（copy 模式）里执行 -> 在飞书原话题回复。
本地项目与飞书群的映射写在 profile 的 `projects` 列表里（每个群一个 chatId）。

## 1. 前置条件

| 项 | 要求 | 本机现状（2026-11-08 核对） |
| --- | --- | --- |
| DSH | 满足 `package.json` 的 `engines.dsh`（`^0.2.1-alpha.2`） | `/usr/local/bin/dsh` 0.2.2-rc.1 |
| Node / pnpm | Node 22.19+ 或 24+，pnpm | v24.22.2 / pnpm 11.7.0 |
| git | 2.32+ | 已装（git worktree 模式需要） |
| Python | 3.8+ | 已装（门户 cookie 脚本、假 lark-cli、冒烟脚本用） |
| 模型 | opencode-go / deepseek-v4.1-flash；key 变量 `OPENCODE_GO_API_KEY` | 已存在于 `~/.dsh/.credentials.yaml` 的 refs（与现有实例共用 `DSH_HOME`） |
| 飞书 | 企业自建应用 + 机器人能力 + 权限 + 长连接事件订阅 + 已发布版本 + 机器人已进群 | 需新建（第 5 步） |
| lark-cli | 官方 Lark/Feishu CLI（基线 1.0.90） | `/usr/local/bin/lark-cli` 1.0.90 |
| 端口 | 3084 未被占用 | `ss -ltnp`（过滤 3084）应为空 |
| 权限 | 安装 systemd unit、改 `/etc/dsh-portal/`、执行 `dsh-portal-refresh` 需要 root（sudo） | 门户相关操作由操作者执行 |
| 目录 | 本地项目目录（git 仓库或普通目录） | 示例 `/home/ubuntu/projects/demo-git`、`demo-copy` |

## 2. 第 1 步：构建 fork

profile 通过 `link:` 引用本仓库，**必须 build 出 `lib/` 后**才能启动；改过 `src/` 后也要重新 build 并重启服务。

~~~sh
cd /home/ubuntu/dsh-superagent-local
pnpm install
pnpm build            # 生成 lib/（git 忽略的构建产物）
pnpm check            # 可选：typecheck + test + build 全量自检
~~~

> `lib/` 是构建产物，不进 git；只 `git pull` 不 build，运行的仍是旧代码。

## 3. 第 2 步：创建独立 profile 并安装 bundle

只在**首次创建**时执行（`--from-default-profile` 会**替换**同名 profile 并删掉它的 `cordis.patch.yml`，已装过不要重跑）：

~~~sh
dsh superagent-local --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent-local add link:/home/ubuntu/dsh-superagent-local
~~~

确认 bundle 已注册：

~~~sh
cat ~/.dsh/profiles/superagent-local/package.json
# dependencies 里应有 "dsh-superagent": "link:/home/ubuntu/dsh-superagent-local"
# dsh.profile.bundles 里应出现 "dsh-superagent"
~~~

生成位置：`$DSH_HOME/profiles/superagent-local/`（默认 `/home/ubuntu/.dsh/profiles/superagent-local`）。
bundle 自带的 `cordis.patch.yml` 负责插入插件条目（`dsh-superagent`、`dsh-superagent-feishu` 默认禁用、worker/router 预设）；
profile 的 `cordis.patch.yml` 只写机器级配置（下一步）。

## 4. 第 3 步：写入 profile 配置

把示例复制为 profile 的补丁层，然后替换所有占位符：

~~~sh
cp /home/ubuntu/dsh-superagent-local/deploy/local/profile.cordis.patch.yml \
   ~/.dsh/profiles/superagent-local/cordis.patch.yml
chmod 600 ~/.dsh/profiles/superagent-local/cordis.patch.yml
$EDITOR ~/.dsh/profiles/superagent-local/cordis.patch.yml
~~~

需要替换/确认的占位符：

| 位置 | 示例值 | 说明 |
| --- | --- | --- |
| `webserver.port` | `3084` | 保持 3084；改端口要同步改门户 upstream |
| `dsh-superagent.stateDir` | `/home/ubuntu/.dsh/state/superagent-local` | 绝对路径；**不能**与现有实例共用（同目录有进程锁） |
| `projects[].name` | `demo-git` / `demo-copy` | 日志和工单短名用 |
| `projects[].path` | `/home/ubuntu/projects/demo-git` 等 | 必须已存在；git 模式还必须是 git 工作树 |
| `projects[].mode` | `git` / `copy` | git = 每单 worktree + `agent/<短名>` 分支；copy = 每单整目录副本 |
| `projects[].chatId` | `oc_REPLACE` | 替换成真实飞书群 `oc_...`；一个群只对应一个项目；整个列表最多一个留空（默认项目） |
| `projects[].base` | 注释掉（= HEAD） | 可选，git 模式从哪个 commit-ish 开分支 |
| `projects[].prepare` | 注释掉 | 可选，覆盖内置准备命令（`sh -c` 执行，10 分钟超时） |
| `connection.trustedHosts` | `dsh.example.com` | 门户域名；不用门户可删掉整段 connection |
| `connection.cookieMaxAgeDays` | `365` | 门户 cookie 由 mint 脚本签发，`--days` 必须 <= 此值 |
| `llm-pi-ai.providers.opencode-go...apiKeyEnv` | `OPENCODE_GO_API_KEY` | key 变量名；真实值在 DSH 凭据或进程环境 |

> 占位符 `oc_REPLACE` 出现两次只是示例；真实部署请给每个项目不同的群 id。
> 配置里的未知键会导致启动失败，日志会指出键名。

改完可先只做 YAML 组装检查（不启动服务）：

~~~sh
dsh superagent-local --dump-config > /dev/null && echo "profile config OK"
~~~

## 5. 第 4 步：准备本地项目目录

**git 模式**（推荐：每单独立 worktree，互不干扰；原目录不动）：

~~~sh
mkdir -p /home/ubuntu/projects
git init /home/ubuntu/projects/demo-git
cd /home/ubuntu/projects/demo-git
# 至少一个提交，否则 worktree add HEAD 会失败
git add -A && git commit -m "init demo project"
git rev-parse --is-inside-work-tree   # 必须输出 true
~~~

每个工单会执行等价于下面的内置准备命令（无需自己写 `prepare`）：

~~~sh
git -C /home/ubuntu/projects/demo-git worktree add -b "agent/<工单短名>" \
  /home/ubuntu/.dsh/state/superagent-local/work/<工单短名> HEAD
~~~

**copy 模式**（非 git 目录，或不想动原目录）：

~~~sh
mkdir -p /home/ubuntu/projects/demo-copy
# 放入要处理的文件
~~~

每个工单会把项目打包到 `<stateDir>/snapshots/<短名>.tar.gz`，并从同一份快照解包出工作副本。
应用前会对照原始快照检查项目。如果项目已有改动，应用会拒绝写入，请先查看工单的差异文件。
注意磁盘占用（每单一份副本 + 一份快照）。

补充：

- 工单目录默认 `<stateDir>/work/<短名>`；`<短名>` = 评估生成的 worktree 名 + 工单 id 前 12 位。
- 附件目录 `<stateDir>/artifacts/<工单 id>`，执行器通过 `DSH_SUPERAGENT_ARTIFACTS` 告知模型，`result.md`、`diff.patch`、截图写这里。
- 自定义 `prepare` 在工单目录的父目录用 `sh -c` 执行一次（10 分钟超时），失败**不会自动重试**；
  可用环境变量：`DSH_SUPERAGENT_DIR`、`DSH_SUPERAGENT_NAME`、`DSH_SUPERAGENT_TICKET`、
  `DSH_SUPERAGENT_PROJECT`、`DSH_SUPERAGENT_PROJECT_PATH`、`DSH_SUPERAGENT_PROJECT_MODE`、`DSH_SUPERAGENT_ARTIFACTS`。
- 项目路径不存在 -> setup 报 `projectMissing`；git 模式目录不是工作树 -> `projectNotGit`。
  这两类错误在 `GET state` 的 `setup.problem`（`place=deployment`）里可见，修好 profile 后重启服务。

## 6. 第 5 步：创建并配置飞书自建应用（人工，控制台）

在飞书开放平台（`https://open.feishu.cn/`；Lark 国际版用 `https://open.larksuite.com/`）创建**企业自建应用**：

1. **添加机器人能力**：应用能力 -> 添加「机器人」。
2. **申请权限**（权限管理；按需最小化，改完必须重新发布版本才生效）：

   | 权限 scope | 用途 |
   | --- | --- |
   | `im:message.p2p_msg:readonly` | 接收单聊消息事件 |
   | `im:message.group_at_msg:readonly` | 接收群里 @ 机器人的消息 |
   | `im:message.group_msg` | 接收群全部消息 / 读群历史（`listen: all`、补收群历史、轮询话题时必需；敏感权限） |
   | `im:message:readonly` | 读消息 / 历史 / 话题 |
   | `im:message:send_as_bot` | 以应用身份发消息、回复 |
   | `im:chat:read` | 获取机器人已加入的群列表（面板刷新群、群名缓存） |
   | `im:chat.members:read` | 读群成员（Policy 的 Sync chat 名单同步） |
   | `im:resource` | 下载消息里的图片/文件 |
   | `contact:user.base:readonly`（可选） | 更好显示用户名；lark-cli 通常已能从消息带出 sender_name，一般不必 |

3. **配置事件订阅**：开发者后台 -> 事件与回调 -> 事件配置：
   - 订阅方式选 **「使用长连接接收事件」**（WebSocket）。lark-cli 的 `event consume` 走长连接，**不需要公网回调地址/NAT 穿透**。
   - 添加事件 **`im.message.receive_v1`**（接收消息 v2.0）。
4. **发布版本**：版本管理与发布 -> 创建版本 -> 申请发布（敏感权限需管理员审批）。**不发布就收不到事件、发不出消息。**
5. **可用范围 / 进群**：把要使用机器人的用户/部门加入应用可用范围；在目标群的「群设置 -> 群机器人」里**把机器人拉进群**。
   机器人不在群里时，读取/发送会报 `232011`（dsh-superagent 会改写成「The Feishu bot is not a member of the chat.」）。
6. 记录 **App ID**（`cli_...`）和 **App Secret**（下一步用；不要写进命令行历史或仓库）。

> **一个实例一个飞书应用/bot**：不要复用现有 superagent 的 bot 配置。两个 `event consume` 用同一个 app
> 会互相抢事件/重复处理；新实例必须用新 app + 独立 `LARKSUITE_CLI_CONFIG_DIR`。

## 7. 第 6 步：安装 bot-only 的 lark-cli 配置和 wrapper

原理：dsh-superagent 的 worker 会把该 CLI 当作 `lark-cli` 调用；Host 启动时会**拒绝还能以用户身份行事的 CLI**
（否则 worker 可冒充操作者）。所以需要独立配置目录 + strict mode bot + wrapper。

~~~sh
# 1) 在该 app 下初始化配置；secret 从 stdin 读，避免出现在进程列表/历史里
export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-superagent-local"
printf %s "$FEISHU_APP_SECRET" | lark-cli config init \
  --app-id cli_xxxxxxxxxxxxxxxx --app-secret-stdin --brand feishu

# 2) 限定只能用 bot 身份（Host 校验 strict-mode 必须正好是 bot）
lark-cli config strict-mode bot --global

# 3) wrapper：固定配置目录后转发（Host 以 lark-cli 调用它）
mkdir -p ~/.local/bin
cat > ~/.local/bin/lark-bot-local <<'EOF'
#!/bin/sh
export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-superagent-local"
exec lark-cli "$@"
EOF
chmod +x ~/.local/bin/lark-bot-local
~~~

自检（全部只读；任何一步失败先修这里，再去面板保存）：

~~~sh
B=~/.local/bin/lark-bot-local
$B auth status                 # identities.bot.status 必须是 ready，appId 正确
$B config strict-mode          # 必须输出 strict-mode: bot
$B whoami --as bot             # identity=bot, tokenStatus=ready
$B api GET /open-apis/bot/v3/info --as bot --format ndjson   # .bot.open_id（ou_...）、.bot.app_name
$B im +chat-list --page-all --page-size 100 | jq '.data.chats[] | {chat_id,name}'
$B im +chat-members-list --chat-id oc_xxxxxxxx --member-types user --page-all --page-limit 0 \
  | jq '.data.users[] | {member_id,name}'
$B event consume im.message.receive_v1 --as bot --dry-run    # preconditions 应全 ok
$B event status                                              # bus/consumers；实例运行中不要另起 consume
~~~

注意：

- **一个 app id 对应一个 lark-cli profile**：独立 `LARKSUITE_CLI_CONFIG_DIR`，避免和个人/现有实例配置冲突。
- 删除 bot 配置时**只删目录**，不要执行 `lark-cli config remove`（会清掉共享 keychain 里的 app secret）。
- 换 secret：后台重置后重跑 `config init`，再到面板 **Check again** 或重新保存 Feishu Source。
- `config init` 在 Agent 环境（`OPENCLAW_HOME`/`HERMES_HOME`）里默认拒绝，需要 `--force-init`；
  本手册在普通 shell 里执行即可。
- lark-cli 基线 1.0.90；升级前先在测试环境验证命令/输出格式没变。

## 8. 第 7 步：安装并启动 systemd 服务

~~~sh
sudo install -m 644 /home/ubuntu/dsh-superagent-local/deploy/local/dsh-superagent-local.service \
  /etc/systemd/system/dsh-superagent-local.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-superagent-local

systemctl status dsh-superagent-local --no-pager
journalctl -u dsh-superagent-local -n 100 --no-pager
~~~

unit 内容见 `deploy/local/dsh-superagent-local.service`（`User=ubuntu`、`HOME`/`DSH_HOME`、
`WorkingDirectory=/home/ubuntu/dsh-superagent-local`、`ExecStart=/usr/local/bin/dsh superagent-local --no-open`）。
以**位置参数**启动 profile（`dsh superagent-local`），所以 `scripts/dsh-superagent status` 只匹配
`--profile` 形式、会误报 exit 1；请用 `systemctl status` 或管理 API 判断健康。

首次启动会：

- 创建 `stateDir`（0700）和其中的数据库/锁/`worker-bin`/`worker-gitconfig`；
- 跑 setup：校验本地项目存在且 git 模式在工作树里；**此时 Feishu CLI 还没配**，所以 Feishu Source 只是暂停，不影响面板；
- 面板起来后，从日志里找带 token 的 URL 打开：

~~~sh
journalctl -u dsh-superagent-local -n 50 --no-pager | grep -E 'http://127\.0\.0\.1:3084'
# 浏览器打开 http://127.0.0.1:3084/?token=...（首次会种会话 cookie）
~~~

如果 setup 报 `projectMissing`/`projectNotGit`：改 profile 的 projects 路径后
`sudo systemctl restart dsh-superagent-local`。

## 9. 第 8 步：首次在面板 / 管理 API 配置 Source、Policy、Execution

打开面板（本地 `http://127.0.0.1:3084`，或门户 `https://dsh.example.com/dsh5/`），侧边栏 **Superagent**。

1. **Settings -> Sources -> 飞书**
   - **Bot lark-cli**：`/home/ubuntu/.local/bin/lark-bot-local`（绝对路径）。
   - **Chats**：每行一个群 `oc_...` + 接收方式「仅 @」或「全部消息」；「全部消息」需要群消息读权限。
   - **Other chats**：机器人已加入但没列出的群：不接收 / 仅 @。
   - **Direct messages**：是否接收私聊。
   - 保存时会校验 app/bot 身份；改 `cli` 会**重启**服务（响应里 `restarting: true`，API 短暂不可用）。
2. **Policy**：Allowed 名单（飞书用户 `ou_...`）或 Sync chat 从群同步；名单为空 = 永远不会有工单。
   Admission 默认值一般够用；Bots 白名单可选。
3. **Eval**：accept mode 建议先 `observe` 观察，稳定后再 `auto`；proactive 接单需要启用的规则。
4. **Execution**：worker 模型（留空 = profile 默认）、`maxWorkers`、工单目录根（留空 = `<stateDir>/work`）、
   `blockedCommands`。**本地项目模式下 `executor.prepare` 不生效**：每个项目用 profile 里的 `prepare` 或内置 git/copy 准备。

用 API 配置等价操作（示例：保存 Feishu Source；改 cli 会触发重启）：

~~~sh
api=http://127.0.0.1:3084/orchestrator/api
H='x-orchestrator-request: 1'
rev=$(curl -s -H "$H" "$api/settings" | jq '.sources[] | select(.id=="feishu") | .revision')
curl -s -X PUT -H "$H" -H 'content-type: application/json' "$api/settings/source:feishu" -d "{
  \"value\": {\"enabled\": true, \"config\": {
    \"cli\": \"/home/ubuntu/.local/bin/lark-bot-local\",
    \"chats\": [{\"chatId\": \"oc_xxxxxxxx\", \"listen\": \"mentions\"}],
    \"otherChats\": \"none\", \"directMessages\": true
  }},
  \"revision\": $rev
}" | jq .
~~~

语义：`revision` 过期 -> 409（重新 GET）；值非法 -> 400 + `issues`；未知 source -> 404；
返回 `restarting: true` 时等 `GET state` 的 `health.runtime.state=ready` 再继续。
完整字段见仓库 `docs/006-deployment.md` 的 Management API 一节（fork 里仍适用）。

## 10. 第 9 步：挂到 nginx 门户 /dsh5/（需要 root）

**模式**（本机现状，2026-11-08 核对）：`/etc/dsh-portal/backends.json` 是门户的单一事实来源；
`sudo dsh-portal-refresh` 读取它，生成：

- `/etc/nginx/conf.d/dsh-paths.inc`：每个后端的 `/dshN/` 路径入口（剥前缀反代，nginx 注入该实例的会话 cookie）；
- `/etc/nginx/conf.d/dsh-portal.conf`、`zz-dsh-subdomains.conf`、选择页 `/var/www/dsh-portal/index.html`；
- 最后自动 `nginx -t` + `systemctl reload nginx`。

现有条目：`sa` -> `127.0.0.1:3082` 挂在 `/dsh3/`；`box3` -> 39081 挂在 `/dsh4/`。
新实例应加：`sa-local` -> `127.0.0.1:3084` 挂在 `/dsh5/`，cookie 用文件
`/etc/dsh-portal/cookies/sa-local.cookie`。

### 10.1 签发门户会话 cookie

门户路径入口由 nginx 把该实例的会话 cookie 注入请求；cookie 必须由**该 DSH_HOME 的 browser-session 密钥**按
**与 Host 相同的 authority** 签发。本机用 `mint-dsh-cookie.py`：

~~~sh
# 前提：profile 里 connection.cookieMaxAgeDays >= 364（本脚手架 365），且实例至少启动过一次
sudo install -d -m 700 /etc/dsh-portal/cookies
python3 /usr/local/bin/mint-dsh-cookie.py \
  --dsh-home /home/ubuntu/.dsh \
  --authority dsh.example.com \
  --days 364 \
  | sudo tee /etc/dsh-portal/cookies/sa-local.cookie > /dev/null
sudo chmod 600 /etc/dsh-portal/cookies/sa-local.cookie
~~~

> `mint-dsh-cookie.py` 的默认 `--authority` 是旧域名 `dsht.twinasset.art`，
> 本机门户当前 authority 是 `dsh.example.com`（见 `dsh-paths.inc` 里的 Host/Origin），**必须显式传**
> `--authority dsh.example.com`，否则实例会判 401。
> `--days` 不能超过实例的 `cookieMaxAgeDays`。

### 10.2 添加 backends.json 条目

先备份，再编辑（`sudoedit /etc/dsh-portal/backends.json` 或 python 脚本），在数组里追加：

~~~json
{
  "id": "sa-local",
  "title": "superagent 本地项目",
  "desc": "单用户本地项目飞书工单 agent（superagent-local，127.0.0.1:3084）",
  "tag": "sa-local · 127.0.0.1:3084",
  "upstream": "127.0.0.1:3084",
  "cookie": "file:/etc/dsh-portal/cookies/sa-local.cookie",
  "path": "/dsh5",
  "orchestrator": true
}
~~~

字段说明：

- `upstream`：本实例回环地址；`cookie` 取 `entry | self | file:<path>`，这里用文件；
- `path`：路径入口 `/dsh5`（脚本会生成 `/dsh5/` 的 location 并剥前缀反代）；
- `orchestrator: true`：**superagent 面板必须加**。面板用绝对路径 `/orchestrator/api/...` 发请求，
  `dsh-portal-refresh` 会为带该标记的后端生成 `map $http_referer $dsh_orch_by_path`，
  门户 vhost 的 `/orchestrator/api/` location 再按 Referer `/dsh5/` 把请求转到 3084，并把 Host/Origin
  改写成 `127.0.0.1:3084`（管理 API 的 same-origin 校验要求）。**缺这个字段时页面能开、数据接口会 404/403。**
- `authority` 省略 = 门户主域 `dsh.example.com`；与 cookie 的 authority、profile 的
  `connection.trustedHosts` 必须一致。

应用：

~~~sh
sudo dsh-portal-refresh        # 会校验 JSON、生成 nginx 配置、nginx -t、reload
# 失败时按报错修：JSON 语法 / cookie 文件不存在 / 证书
~~~

验收（浏览器，需门户 Basic auth）：`https://dsh.example.com/dsh5/` 应打开新实例面板；
选择页 `/portal` 也会多一张卡片。门户相关细节以门户仓库的 `runbooks/add-dsh-host.md` 为准。

## 11. 第 10 步：验收

~~~sh
systemctl status dsh-superagent-local --no-pager
journalctl -u dsh-superagent-local -n 100 --no-pager

api=http://127.0.0.1:3084/orchestrator/api
H='x-orchestrator-request: 1'

# 1) setup 与健康：problem=null、feishuProblem=null、feishu/history=ready
curl -s -H "$H" "$api/state" | jq '{setup, health, load}'

# 2) Source 状态：feishu.state=ready，stats.received 随消息增长
curl -s -H "$H" "$api/sources" | jq '.[] | {id, state, health, stats, filtered, dropped}'
~~~

期望：`setup.problem=null`、`setup.feishuProblem=null`、
`setup.accounts.feishu` 里有 `appId`/`botId`/`name`、
`health.feishu` = `ready` 且 `detail` 为 `Listening for bot events`、
`health.history` = `ready`。本地项目模式下 `setup.accounts.repository`/`agent` 为空字符串是正常的。

3) **真实 @ 消息验收**：用 Allowed 名单里的账号，在已配置的群里 **@机器人** 发一条请求（或私聊）。
   预期：机器人先在原话题回一条确认；面板 **Execution** 出现新 Ticket；执行器在本地项目
   worktree/副本里工作；完成后在**原话题**回结果；在同一话题继续回复属于同一工单。
4) 面板操作：**Retry**（输入投递失败或 blocked/failed 后）、**Stop**（人工停止）、**Pause processing**。
5) 门户验收：`https://dsh.example.com/dsh5/` 能打开并读写数据（面板请求经 `/orchestrator/api/` 路由）。

## 12. 假 lark-cli 冒烟测试（没有真实飞书应用时）

目标：用 `deploy/local/fake-lark-cli.sh` 代替真实 lark-cli，在**临时 DSH_HOME / 临时 stateDir / 临时端口**上
跑通「setup 校验 -> 事件消费 -> Trigger 入库」链路；**不碰**现有 profile、stateDir 和服务。适合改完代码后的回归。

假 CLI 的契约见脚本头部注释；独立自检：

~~~sh
CLI=/home/ubuntu/dsh-superagent-local/deploy/local/fake-lark-cli.sh
$CLI auth status
$CLI config strict-mode
$CLI api GET /open-apis/bot/v3/info --as bot --format ndjson
$CLI im +chat-list --page-all --page-size 100
$CLI --help
~~~

完整冒烟（复制整段执行）：

~~~sh
set -euo pipefail
CLI=/home/ubuntu/dsh-superagent-local/deploy/local/fake-lark-cli.sh
SMOKE=/tmp/sa-local-smoke
rm -rf "$SMOKE"
mkdir -p "$SMOKE/projects/demo-git" "$SMOKE/projects/demo-copy" "$SMOKE/log"

# 临时项目：git 模式要有一个提交
git -C "$SMOKE/projects/demo-git" init -q
git -C "$SMOKE/projects/demo-git" config user.email smoke@example.com
git -C "$SMOKE/projects/demo-git" config user.name Smoke
echo demo > "$SMOKE/projects/demo-git/README.md"
git -C "$SMOKE/projects/demo-git" add -A
git -C "$SMOKE/projects/demo-git" commit -qm init
echo demo > "$SMOKE/projects/demo-copy/README.md"

# 临时 profile（独立 DSH_HOME，不读写 ~/.dsh）
export DSH_HOME="$SMOKE/dsh"
dsh smoke-local --from-default-profile web --dump-config > /dev/null
dsh plugin --profile smoke-local add link:/home/ubuntu/dsh-superagent-local

# 用示例 profile 补丁生成临时配置：替换 stateDir/端口/项目路径/群 id
python3 - "$SMOKE" <<'PY'
import pathlib, sys
smoke = sys.argv[1]
src = pathlib.Path('/home/ubuntu/dsh-superagent-local/deploy/local/profile.cordis.patch.yml').read_text()
out = (src.replace('/home/ubuntu/.dsh/state/superagent-local', smoke + '/state')
          .replace('port: 3084', 'port: 3085')
          .replace('/home/ubuntu/projects/demo-git', smoke + '/projects/demo-git')
          .replace('/home/ubuntu/projects/demo-copy', smoke + '/projects/demo-copy')
          .replace('chatId: oc_REPLACE', 'chatId: oc_fakechatlocal', 1)
          .replace('chatId: oc_REPLACE', 'chatId: oc_fakechatlocal2', 1))
pathlib.Path(smoke + '/dsh/profiles/smoke-local/cordis.patch.yml').write_text(out)
PY

# 启动临时实例；假 CLI 通过环境变量找到事件文件和回复记录
export FAKE_FEISHU_EVENTS="$SMOKE/events.ndjson"
export FAKE_FEISHU_OUT="$SMOKE/out.ndjson"
cd /home/ubuntu/dsh-superagent-local
dsh smoke-local --no-open > "$SMOKE/log/dsh.log" 2>&1 &
echo $! > "$SMOKE/dsh.pid"

# 等管理 API 起来（最多 60s）
for i in $(seq 1 60); do
  curl -sf -H 'x-orchestrator-request: 1' http://127.0.0.1:3085/orchestrator/api/state > /dev/null && break
  sleep 1
done

api=http://127.0.0.1:3085/orchestrator/api
H='x-orchestrator-request: 1'

# 1) 把 Feishu Source 指向假 CLI（保存会触发重启 + setup 重新校验）
rev=$(curl -s -H "$H" "$api/settings" | jq '.sources[] | select(.id=="feishu") | .revision')
curl -s -X PUT -H "$H" -H 'content-type: application/json' "$api/settings/source:feishu" -d "{
  \"value\": {\"enabled\": true, \"config\": {
    \"cli\": \"/home/ubuntu/dsh-superagent-local/deploy/local/fake-lark-cli.sh\",
    \"chats\": [{\"chatId\": \"oc_fakechatlocal\", \"listen\": \"mentions\"}],
    \"otherChats\": \"none\", \"directMessages\": true
  }},
  \"revision\": $rev
}" | jq .

# 2) 等重启完成、Feishu 事件消费者就绪（最多 60s）
for i in $(seq 1 60); do
  state=$(curl -s -H "$H" "$api/sources" | jq -r '.[] | select(.id=="feishu") | .state' 2>/dev/null || true)
  [ "$state" = "ready" ] && break
  sleep 1
done
curl -s -H "$H" "$api/state" | jq '{setup, health}'

# 3) 写入一条 NDJSON 事件（机器人被 @；时间用当前毫秒）
python3 - "$FAKE_FEISHU_EVENTS" <<'PY'
import json, sys, time
event = {
    "message_id": "om_smoke1",
    "chat_id": "oc_fakechatlocal",
    "chat_type": "group",
    "sender_id": "ou_fakeuserlocal",
    "sender_type": "user",
    "content": "冒烟测试：修一下 demo 的 bug",
    "create_time": str(int(time.time() * 1000)),
    "mentions": [{"id": "ou_fakebotlocal", "name": "Fake Bot"}],
}
open(sys.argv[1], 'w', encoding='utf-8').write(json.dumps(event, ensure_ascii=False) + '\n')
PY

# 假消费者最多等 30s 事件文件；给足时间后再查
sleep 3
curl -s -H "$H" "$api/sources" | jq '.[] | select(.id=="feishu") | {state, health, stats}'
# 期望：state=ready；health[0].detail="Listening for bot events"；stats.received >= 1

# 4) Gate 已处理该事件（allowed 名单为空时是 ignore/not_a_member，说明链路走通）
curl -s -H "$H" "$api/decisions?window=24h" | jq '.items[] | {kind, reason, thread}'

# 5) 清理：停临时实例并删除临时目录
kill "$(cat "$SMOKE/dsh.pid")" 2>/dev/null || true
wait 2>/dev/null || true
rm -rf "$SMOKE"
~~~

说明：

- 临时 `DSH_HOME` **不共享** `~/.dsh/.credentials.yaml` 的模型 key；只验证飞书接入链路时不需要模型。
  若要走到「建工单 + 回复」还需要：`export OPENCODE_GO_API_KEY=...` 后再启动，并在 Policy 里把
  `ou_fakeuserlocal` 加进 allowed；成功时 `$FAKE_FEISHU_OUT` 里会多出
  `im +messages-reply` 的 argv 记录（确认 + 结果回复）。
- 假 CLI 的消息读取类命令返回空列表，模型读线程上下文会报「消息不可用」；这是预期限制。
- 若 `GET state` 的 `setup.problem` 报 `projectMissing`，检查临时项目目录和 profile 里的替换是否成功。
- 冒烟测试证明的是「dsh-superagent 侧链路」，**不能**证明飞书后台的权限/事件/发布配置正确（那必须真实 @ 验收）。
- **本机实测（2026-11-08）**：按上面的步骤用临时 profile `smoke-local`（`DSH_HOME=/tmp/sa-local-smoke/dsh`）、
  临时 stateDir、端口 3085 和 `fake-lark-cli.sh` 跑通：setup 解析出
  `appId=cli_fakebotlocal`/`botId=ou_fakebotlocal`/`name=Fake Bot`、`setup.problem=null`、
  `health.feishu/history=ready`、事件入库后 `stats.received=1`、Gate 记录
  `kind=ignore, reason=not_a_member`（因为还没配 allowed）。未覆盖：真实模型评估建工单/回复、门户、真实飞书后台。

## 13. 排障速查

| 现象 | 原因与处理 |
| --- | --- |
| `Feishu event consumer did not become ready within 45 seconds` | 后台没开「长连接接收事件」/ 没加 `im.message.receive_v1` / 版本没发布 / 权限没批 / 可用范围不含操作者。跑 `lark-bot-local event consume im.message.receive_v1 --as bot --dry-run` 和 `event status`，看 `~/.lark-cli-superagent-local/events/<appid>/bus.log`；实例运行中不要另起一个 consume |
| `The bot lark-cli allows user identities` | strict mode 不是 bot。确认 wrapper 指向 `~/.lark-cli-superagent-local`，执行 `lark-cli config strict-mode bot --global`，面板 **Check again** |
| `The bot lark-cli does not work.` / `The bot identity of app ... is ...` | app id/secret 错或 secret 已重置。重跑 `config init`，再保存 Feishu Source / Check again |
| `The Feishu bot is not a member of the chat.`（错误码 232011） | 把机器人加进群（群设置 -> 群机器人），再重试/保存 |
| `projectMissing`（`setup.problem.place=deployment`） | projects.path 不存在或不是目录；改 profile 后重启服务 |
| `projectNotGit` | git 模式目录不是 git 工作树：`git init` + 至少一个提交，或把 mode 改成 copy |
| 群里发消息没反应 / `GET sources` 里 filtered | 群不在 Source 的 Chats 且 otherChats=none（`chat_not_allowed`）；listen=mentions 时未 @ 只记 filtered；私聊开关关；机器人不在群；发送者不在 allowed（Decision 里是 ignore 类原因） |
| 工单失败 `No local project is configured for this Feishu chat` / `projectUnmapped` | 该群 chatId 没有对应 project：在 profile 的 projects 里加一项，或把某项 chatId 留空做默认项目；重启后 Retry 工单或发新消息 |
| `The prepare command failed: ...` | 内置 git worktree/copy 或项目自定义 prepare 失败；输出里有原因。prepare **失败不会自动重试**，且失败留下的非空目录会保留（可能被当成已准备）；修好后 Retry 或发新消息 |
| 回复发不出去 / 面板 Outbox 失败 | 看 `GET sources` 的 `dropped`；检查 lark-cli wrapper、机器人是否在群、`im:message:send_as_bot` 权限/版本是否发布 |
| 模型报错 / 401 | `OPENCODE_GO_API_KEY` 没解析到：面板 Models 页保存 key，或 systemd `Environment=` 提供；看 `GET state` 的 `health.models` |
| 启动失败、端口占用 | `ss -ltnp` 查 3084 是否被占用；换端口要同时改 profile 和门户 upstream |
| 日志 `already being held` / 锁冲突 | 两个实例共用同一 stateDir；停掉旧的或改 stateDir |
| 经门户面板 404/403、数据接口打不开 | backends.json 条目缺 `"orchestrator": true`；cookie 的 authority 不是 `dsh.example.com` 或已过期；`sudo dsh-portal-refresh` 是否成功；profile 的 `connection.trustedHosts` 是否含门户域名 |
| 门户 cookie 被实例判 401 | `mint-dsh-cookie.py --days` 大于 profile 的 `cookieMaxAgeDays`，或 authority 与 nginx Host 不一致；重新签发 |
| systemd 起不来 | `journalctl -u dsh-superagent-local -n 200 --no-pager`；常见：profile 未创建、`lib/` 未 build、stateDir 权限、profile YAML 配置错误 |
| `scripts/dsh-superagent status` 报 exit 1 但服务正常 | 位置参数启动（`dsh superagent-local`），脚本只匹配 `--profile`；用 `systemctl status` / `GET state` |
| lark-cli 提示可升级 | 基线 1.0.90；升级前先在测试环境验证命令/输出格式 |
| `dsh-superagent configuration has keys it does not use` | profile 的 `dsh-superagent.config` 里有旧键/错键；按日志提示删除（repository/blockedCommands 等已移到别处） |

## 14. 升级与回滚

~~~sh
# 升级（确认没有正在执行的工单更稳妥）
cd /home/ubuntu/dsh-superagent-local
git pull && pnpm install && pnpm build
sudo systemctl restart dsh-superagent-local

# 升级前备份 stateDir 数据库
cp -a /home/ubuntu/.dsh/state/superagent-local/orchestrator.sqlite* /path/to/backup/
~~~

数据库被新版本迁移后旧版本打不开，回滚需要升级前的备份。DSH 本体升级后要重启本实例以加载匹配的产物。

## 15. 安全提示（单用户本机模式）

- worker/router 预设以 `danger-full-access`、无审批的方式以 `ubuntu` 用户运行，等同操作者权限；
  本机单用户场景可接受，多用户/生产请用专用 OS 账号或容器隔离。
- 机器人只给 **bot-only** CLI（strict mode bot），不要把个人飞书身份给 worker。
- 面板/管理 API 只监听回环；对外只经 nginx 门户（Basic auth）。
- `stateDir` 不要随意迁移；`worker-bin`/`worker-gitconfig` 里不是本程序写的文件会阻止启动。
- 飞书 app secret、模型 key 不要写进仓库/命令历史；unit 文件含密钥时 chmod 600。

## 16. 本脚手架未执行 / 未验证的点（操作者需自行确认）

- **飞书开放平台控制台**：建应用、加机器人能力、权限名与审批、长连接事件订阅、发布版本、可用范围、拉机器人进群——
  只能人工在控制台完成；权限名以飞书当前文档为准。
- **第 2/3 步的 profile 命令**（`--from-default-profile web --dump-config`、`dsh plugin --profile … add link:…`、
  `--dump-config` 组装）已用**临时 profile**（`smoke-local` + 临时 `DSH_HOME`）实际验证通过；
  但 `superagent-local` 这个名字本身没有在本机创建（避免影响现有 profile/服务）。
- **门户相关**（backends.json、`dsh-portal-refresh`、`mint-dsh-cookie.py`、cookie 文件）需要 root，未执行；
  条目字段依据 `/usr/local/bin/dsh-portal-refresh` 源码和现有 `/etc/nginx/conf.d/dsh-paths.inc`
  （`/dsh3` -> 3082、`/dsh4` -> 39081）推导；`/etc/dsh-portal` 目录当前对普通用户不可读。
- **假 lark-cli**：契约已用独立脚本自测（auth/config/bot info/chat-list/members/mget/threads/api/回复记录/事件消费/SIGTERM 退出）；
  并已在**临时 profile/stateDir/端口 3085 + 完整 dsh-superagent 实例**上跑通 setup、事件消费、Trigger 入库和 Gate 决策
  （2026-11-08，fork `lib/` 为当日 21:59 的 `pnpm build` 产物）。未覆盖：真实模型评估建工单/回复、门户链路、真实飞书后台配置。
- **lark-cli 1.0.99** 与 1.0.90 的命令/输出兼容性未验证。
- 真实群 `chat_id`、用户 `open_id`、App ID/Secret 需实际查询/申请。
