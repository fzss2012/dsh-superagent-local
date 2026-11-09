# Local-mode E2E verification (fake Feishu bot)

Date: 2026-11-08 (Asia/Shanghai). Fork: /home/ubuntu/dsh-superagent-local. Instance: profile `superagent-local`, port 3084, DSH_HOME=/home/ubuntu/.dsh, fake lark-cli at /tmp/fake-lark-cli (see deploy/local/fake-lark-cli.sh for the maintained copy).

This report records a full end-to-end run without a real Feishu console app: a shell fake lark-cli implements the CLI surface dsh-superagent uses (auth status, config strict-mode, bot info, `event consume im.message.receive_v1`, chat list/members, message reads, threaded replies with attachments). The model was the real configured provider (opencode-go / deepseek-v4.1-flash).

## Topology

- Two local projects: /home/ubuntu/projects/demo-git (git mode, initialized with one commit) and /home/ubuntu/projects/demo-copy (copy mode, plain folder with notes.txt).
- Feishu source mapping via project registry: chat ...0001 -> demo-git, chat ...0002 -> demo-copy.
- Policy allowed list: fake user ou_fakeuser...; accept mode observe; explicit @mentions create tickets (observe does not block explicit requests).
- Fake events were appended to a file; the fake consumer emits them after printing the ready marker. Restarting the consumer re-emits its file; duplicate message ids are deduplicated by the host.

## What was proven

1. **Feishu intake -> Ticket**: fake event `om_faketest...` (group chat, @bot mention, allowed user) produced Trigger -> Eval -> Decision accept (reason explicitRouted) -> Ticket `dadbc329452b2992ba615642b238581c` in 3.7 s. An acknowledgement reply was sent through the fake lark-cli.
2. **git-mode prepare**: ticket directory `<stateDir>/work/create-hello-txt-dadbc329452b` was created as a git worktree on branch `agent/create-hello-txt-dadbc329452b` of demo-git; the project checkout stayed clean.
3. **worker + artifacts**: the worker created HELLO.txt, committed it (commit `88ba654`), and wrote `result.md` and `diff.patch` into `<stateDir>/artifacts/<ticketId>/` (as instructed by the rewritten prompts / DSH_SUPERAGENT_ARTIFACTS).
4. **mobile-first reply with attachments**: the main Session sent a short message (`#dadbc3 ...`) and attached `result.md` and `diff.patch`; the fake CLI logged three separate threaded replies (text, file result.md, file diff.patch). Outbox shows all receipts `sent`.
5. **apply (git)**: after a human "应用" follow-up on the same thread, the worker called `orchestrator_ticket_apply`; demo-git master fast-forwarded to `88ba654`, the project checkout is clean, and the ticket ended. The result reply (with attachments) was delivered. (A first attempt exposed a real bug: the worker git identity is `useConfigOnly`, so `git merge` needed an explicit `-c user.name/-c user.email`; fixed in `src/app/apply.ts`.)
6. **copy-mode prepare**: chat ...0002 event produced ticket `d78e89d763b22ba92c71349ca00a0f99`; prepare snapshot `<stateDir>/snapshots/append-notes-line-d78e89d763b2.tar.gz` and copied the folder into the ticket directory; the worker appended `copy mode works` in the copy and wrote artifacts; the original folder stayed untouched until apply.
7. **apply (copy)**: "应用" in the copy ticket thread synced the ticket copy back after creating backup `append-notes-line-d78e89d763b2-apply-2026-11-08T14-27-40-117Z.tar.gz`; the original notes.txt became two lines. The result reply confirmed the backup.
8. **状态 command**: a new @bot message "状态" was routed as a command, not accepted as a ticket (Decision ignore with reason "operator's 状态 command ..."), and the main Session replied: "当前没有进行中的工单。#dadbc3 与 #d78e89 均已完成并已应用。" (short, mobile-readable, ticket ids).
9. **restart recovery**: the DSH instance was restarted twice mid-ticket; assignments resumed with recovery notes, the same Session/worktree continued, and no duplicate tickets/triggers were created (deterministic trigger ids + intake dedupe).
10. **isolation**: the existing superagent instance on 127.0.0.1:3082 and its stateDir were not touched; this instance used its own profile, stateDir, port and fake bot.

## Evidence excerpts

- Decisions: accept `5f18b269...` (explicitRouted, ticket dadbc329...); accept `0e55b5d6...` (ticket d78e89...); ignore `347f3e4b...` (状态 command).
- Outbox receipts (all sent): ack + result with [result.md, diff.patch] for dadbc329...; ack + result with [result.md, diff.patch] for d78e89...; two apply acknowledgements/results.
- demo-git: `88ba654 (HEAD -> master, agent/create-hello-txt-dadbc329452b) Add HELLO.txt with hello from feishu ticket`; demo-copy notes.txt: two lines ending with `copy mode works`.
- Artifacts: `<stateDir>/artifacts/dadbc329.../{result.md,diff.patch}` and `<stateDir>/artifacts/d78e89.../{result.md,diff.patch}`.

## Not covered here (operator-only)

- Real Feishu self-built app creation, scope approval, long-connection event subscription, version publication, and bot membership in real chats (see setup.md).
- nginx portal /dsh5 entry and cookie minting require root (see setup.md).
- Real user open_ids/chat ids and the operator's actual project folders must replace the demo values in the profile patch and panel.

## Reproduce

See `setup.md` §"假 CLI 冒烟" and `fake-lark-cli.sh`. The run used:
```sh
env DSH_HOME=/home/ubuntu/.dsh FAKE_FEISHU_EVENTS=/tmp/fake-feishu-events.ndjson \
  /usr/local/bin/dsh superagent-local --no-open
```
with source:feishu setting `cli=/tmp/fake-lark-cli`, chats mapped to demo projects, and events appended as NDJSON.
