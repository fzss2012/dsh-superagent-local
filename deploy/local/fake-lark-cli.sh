#!/usr/bin/env bash
# fake-lark-cli.sh — 离线 E2E 用的假 lark-cli（只服务 dsh-superagent 的 Feishu Source）
#
# 用途：没有真实飞书自建应用时，用本脚本代替 lark-cli，跑通 dsh-superagent 的
# setup 校验、事件消费、回复投递等链路。它不联网、不做鉴权，只按 dsh-superagent
# 实际调用的参数返回固定 JSON，因此只能用于冒烟/联调，不能当生产 CLI。
#
# 快速自检（不启动 DSH）：
#   ./fake-lark-cli.sh auth status
#   ./fake-lark-cli.sh config strict-mode
#   ./fake-lark-cli.sh api GET /open-apis/bot/v3/info --as bot --format ndjson
#   ./fake-lark-cli.sh im +chat-list --page-all --page-size 100
#   FAKE_FEISHU_EVENTS=/tmp/events.ndjson ./fake-lark-cli.sh event consume im.message.receive_v1 --as bot
#
# 契约（dsh-superagent 源码实际调用；改契约前先看 src/deployment.ts、src/infra/commands.ts、
# src/sources/feishu.ts、src/sources/feishu-loops.ts、src/sources/feishu-read.ts）：
#   auth status
#       -> 一行 JSON：{"appId":"cli_...","brand":"feishu","identities":{"bot":{"status":"ready"}}}
#   config strict-mode
#       -> strict-mode: bot
#   api GET /open-apis/bot/v3/info --as bot --format ndjson
#       -> 一行 NDJSON：{"bot":{"open_id":"ou_...","app_name":"Fake Bot"}}
#   event consume im.message.receive_v1 --as bot
#       -> 先在 stderr 打印 "[event] ready"；随后把 $FAKE_FEISHU_EVENTS 的每一行（NDJSON，
#          一行一个事件）原样写到 stdout；文件还不存在时先等它出现（默认最多等 30 秒）；
#          之后常驻，收到 SIGTERM/SIGINT 时以退出码 0 结束。
#   event 的其他子命令（如 event status）
#       -> stderr 说明后 exit 1
#   im +messages-reply ...
#       -> 把 {"argv":[...],"at":"<ISO-8601 UTC>"} 追加到 $FAKE_FEISHU_OUT（默认
#          /tmp/fake-feishu-out.ndjson），并打印 {"ok":true,"data":{"message_id":"om_fake"}}；
#          argv 含 dsh-superagent 追加的 --as bot --format json 等全部参数。
#   im +chat-list ...
#       -> {"ok":true,"data":{"chats":[{"chat_id":"oc_...","name":"Fake Chat"}]}}
#   im +chat-members-list ...
#       -> {"ok":true,"data":{"users":[{"member_id":"ou_...","name":"Fake User"}],"has_more":false}}
#          （has_more 必须存在：Policy 名单同步会拒绝被截断的成员列表）
#   im +messages-mget ...
#       -> {"ok":true,"data":{"messages":[],"has_more":false}}
#   im +threads-messages-list ...
#       -> {"ok":true,"data":{"messages":[],"has_more":false,"thread_id":"omt_..."}}
#   api GET /open-apis/im/v1/messages ...
#       -> {"ok":true,"data":{"items":[],"has_more":false}}
#   api GET /open-apis/im/v1/messages/mget ...
#       -> {"ok":true,"data":{"items":[]}}
#   其他未知命令
#       -> {"ok":true,"data":{}}（dsh-superagent 对未知命令只要求合法 JSON）
#
# 环境变量（都可用环境覆盖，便于在冒烟测试里断言）：
#   FAKE_FEISHU_EVENTS       事件 NDJSON 文件路径（默认 /tmp/fake-feishu-events.ndjson）
#   FAKE_FEISHU_EVENTS_WAIT  等待事件文件出现的秒数（默认 30；0 = 不等待）
#   FAKE_FEISHU_OUT          回复调用记录文件（默认 /tmp/fake-feishu-out.ndjson）
#   FAKE_FEISHU_APP_ID       app id（默认 cli_fakebotlocal；须匹配 ^cli_[A-Za-z0-9]+$）
#   FAKE_FEISHU_BRAND        feishu | lark（默认 feishu）
#   FAKE_FEISHU_BOT_OPEN_ID  机器人 open_id（默认 ou_fakebotlocal；须匹配 ^ou_[A-Za-z0-9]+$）
#   FAKE_FEISHU_BOT_NAME     机器人名（默认 Fake Bot）
#   FAKE_FEISHU_CHAT         群 chat_id（默认 oc_fakechatlocal；须匹配 ^oc_[A-Za-z0-9]+$）
#   FAKE_FEISHU_CHAT_NAME    群名（默认 Fake Chat）
#   FAKE_FEISHU_USER         成员 open_id（默认 ou_fakeuserlocal）
#   FAKE_FEISHU_USER_NAME    成员名（默认 Fake User）
#   FAKE_FEISHU_THREAD_ID    threads-messages-list 返回的 thread_id（默认 omt_fakethreadlocal）
#
# 事件行示例（一行一个 JSON；mentions 里放机器人的 open_id 才会被当成「@机器人」）：
#   {"message_id":"om_fake1","chat_id":"oc_fakechatlocal","chat_type":"group",
#    "sender_id":"ou_fakeuserlocal","sender_type":"user","content":"修一下 demo 的 bug",
#    "create_time":"1762524000000","mentions":[{"id":"ou_fakebotlocal","name":"Fake Bot"}]}
#
# 已知限制（冒烟测试够用，完整工单链路仍建议接真实飞书应用）：
#   * 消息读取类命令返回空列表，模型读取线程上下文时会报「消息不可用」；
#   * 回复只写记录文件，不会真的发到飞书；
#   * 不校验任何 token/权限，不能用于验证飞书后台配置是否正确。
#
# 依赖：bash、python3（用于生成合法 JSON；机器上已有）。
set -uo pipefail

APP_ID=${FAKE_FEISHU_APP_ID:-cli_fakebotlocal}
BRAND=${FAKE_FEISHU_BRAND:-feishu}
BOT_OPEN_ID=${FAKE_FEISHU_BOT_OPEN_ID:-ou_fakebotlocal}
BOT_NAME=${FAKE_FEISHU_BOT_NAME:-Fake Bot}
CHAT=${FAKE_FEISHU_CHAT:-oc_fakechatlocal}
CHAT_NAME=${FAKE_FEISHU_CHAT_NAME:-Fake Chat}
USER=${FAKE_FEISHU_USER:-ou_fakeuserlocal}
USER_NAME=${FAKE_FEISHU_USER_NAME:-Fake User}
THREAD_ID=${FAKE_FEISHU_THREAD_ID:-omt_fakethreadlocal}
EVENTS=${FAKE_FEISHU_EVENTS:-/tmp/fake-feishu-events.ndjson}
EVENTS_WAIT=${FAKE_FEISHU_EVENTS_WAIT:-30}
OUT=${FAKE_FEISHU_OUT:-/tmp/fake-feishu-out.ndjson}

usage() {
  cat <<'EOF'
fake-lark-cli.sh — dsh-superagent Feishu Source 的假 lark-cli（离线 E2E）

用法：
  fake-lark-cli.sh <命令> [参数...]

支持的命令（与 dsh-superagent 实际调用一致）：
  auth status
  config strict-mode
  api GET /open-apis/bot/v3/info --as bot --format ndjson
  api GET /open-apis/im/v1/messages [--params <json>] [--as bot] [--format json]
  api GET /open-apis/im/v1/messages/mget [--params <json>] [...]
  event consume im.message.receive_v1 --as bot
  im +messages-reply --message-id <om> --markdown <text> --reply-in-thread --idempotency-key <id>
  im +chat-list [--page-all] [--page-size N]
  im +chat-members-list --chat-id <oc> [--member-types user] [--page-all] [--page-limit 0]
  im +messages-mget --message-ids <om> [--no-reactions]
  im +threads-messages-list --thread <omt> [--order asc|desc] [--page-size N]
  --help | -h | help

事件来源：$FAKE_FEISHU_EVENTS（默认 /tmp/fake-feishu-events.ndjson，NDJSON，一行一个事件）
回复记录：$FAKE_FEISHU_OUT（默认 /tmp/fake-feishu-out.ndjson）
EOF
}

# 打印 {"ok":true,"data":<json>}；<json> 由调用方保证合法。
ok() { printf '{"ok":true,"data":%s}\n' "$1"; }

auth_status() {
  python3 - "$APP_ID" "$BRAND" <<'PY'
import json, sys
print(json.dumps({"appId": sys.argv[1], "brand": sys.argv[2], "identities": {"bot": {"status": "ready"}}}))
PY
}

bot_info() {
  python3 - "$BOT_OPEN_ID" "$BOT_NAME" <<'PY'
import json, sys
print(json.dumps({"bot": {"open_id": sys.argv[1], "app_name": sys.argv[2]}}))
PY
}

chat_list() {
  python3 - "$CHAT" "$CHAT_NAME" <<'PY'
import json, sys
print(json.dumps({"ok": True, "data": {"chats": [{"chat_id": sys.argv[1], "name": sys.argv[2]}]}}, ensure_ascii=False))
PY
}

chat_members() {
  python3 - "$USER" "$USER_NAME" <<'PY'
import json, sys
print(json.dumps({"ok": True, "data": {"users": [{"member_id": sys.argv[1], "name": sys.argv[2]}], "has_more": False}},
                 ensure_ascii=False))
PY
}

# 把一次 im +messages-reply 的完整 argv 追加到 $FAKE_FEISHU_OUT；并发调用下每行仍是一次完整写入。
log_reply() {
  mkdir -p "$(dirname "$OUT")" 2>/dev/null || true
  python3 - "$OUT" "$@" <<'PY'
import json, sys, time
out, argv = sys.argv[1], sys.argv[2:]
line = json.dumps({"argv": argv, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, ensure_ascii=False)
with open(out, "a", encoding="utf-8") as handle:
    handle.write(line + "\n")
PY
}

thread_messages() {
  # 允许 --thread 覆盖默认 thread id；其余参数不影响输出。
  local thread=$THREAD_ID
  local previous=""
  for argument in "$@"; do
    if [ "$previous" = "--thread" ]; then thread=$argument; fi
    previous=$argument
  done
  python3 - "$thread" <<'PY'
import json, sys
print(json.dumps({"ok": True, "data": {"messages": [], "has_more": False, "thread_id": sys.argv[1]}}))
PY
}

# 事件消费：ready -> 等事件文件 -> 逐行输出 -> 常驻到 SIGTERM/SIGINT。
run_consume() {
  trap 'exit 0' TERM INT
  echo '[event] ready' >&2
  local waited=0 limit=$((EVENTS_WAIT * 10))
  while [ ! -f "$EVENTS" ]; do
    if [ "$waited" -ge "$limit" ]; then
      echo "[event] $EVENTS not found after ${EVENTS_WAIT}s; staying up without emitting events" >&2
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ -f "$EVENTS" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] && printf '%s\n' "$line"
    done < "$EVENTS"
  fi
  while :; do sleep 0.2; done
}

argv=("$@")
command=${1:-}
[ "$#" -gt 0 ] && shift

case "$command" in
  help|--help|-h)
    usage
    ;;
  auth)
    case "${1:-}" in
      status) auth_status ;;
      *) echo 'fake-lark-cli: unsupported auth subcommand (only "auth status")' >&2; exit 1 ;;
    esac
    ;;
  config)
    case "${1:-}" in
      strict-mode) printf 'strict-mode: bot\n' ;;
      *) echo 'fake-lark-cli: unsupported config subcommand (only "config strict-mode")' >&2; exit 1 ;;
    esac
    ;;
  event)
    # dsh-superagent 只调用 event consume im.message.receive_v1；其他 event 子命令一律失败。
    if [ "${1:-}" = consume ] && [ "${2:-}" = im.message.receive_v1 ]; then
      run_consume
    else
      echo 'fake-lark-cli: unsupported event command (only "event consume im.message.receive_v1")' >&2
      exit 1
    fi
    ;;
  api)
    method=${1:-}
    path=${2:-}
    case "$method $path" in
      'GET /open-apis/bot/v3/info') bot_info ;;
      'GET /open-apis/im/v1/messages') ok '{"items":[],"has_more":false}' ;;
      'GET /open-apis/im/v1/messages/mget') ok '{"items":[]}' ;;
      *) ok '{}' ;;
    esac
    ;;
  im)
    subcommand=${1:-}
    [ "$#" -gt 0 ] && shift
    case "$subcommand" in
      +messages-reply)
        log_reply "${argv[@]}"
        ok '{"message_id":"om_fake"}'
        ;;
      +chat-list) chat_list ;;
      +chat-members-list) chat_members ;;
      +messages-mget) ok '{"messages":[],"has_more":false}' ;;
      +threads-messages-list) thread_messages "$@" ;;
      *) ok '{}' ;;
    esac
    ;;
  *)
    ok '{}'
    ;;
esac
