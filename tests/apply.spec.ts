/** Authorized local-project apply against disposable Git and copy workspaces. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyTicket, type ApplyHost } from '../src/app/apply.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

async function completed(mode: 'git' | 'copy') {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot Fix it'))
  h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'Ready' })
  const stateDir = h.runtime.machine.stateDir
  const project = join(stateDir, "operator's project")
  mkdirSync(project)
  const spawn = vi.fn(({ argv, cwd }: { argv: string[]; cwd: string }) => {
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', env: gitEnv() })
    if (result.error) throw result.error
    const reader = (text: string) => ({ readFrom: () => ({ text }) })
    return { done: Promise.resolve({ exitCode: result.status }), collected: {
      stdout: reader(result.stdout), stderr: reader(result.stderr),
    } }
  })
  const host: ApplyHost = {
    store: h.runtime.store, stateDir, feishuBotName: () => 'bot',
    project: () => ({ name: 'demo', mode, path: project, chatId: '', base: '', prepare: '' }),
    context: { subprocess: { spawn } as unknown as ApplyHost['context']['subprocess'] },
  }
  return { host, ticket, project, spawn }
}

function projectGit(project: string, branch: string, conflict: boolean) {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd: project, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const file = join(project, 'work.txt')
  const commit = (content: string) => {
    writeFileSync(file, content)
    git('add', 'work.txt')
    git('commit', '-m', content)
  }
  git('init', '-b', 'main')
  commit('base')
  git('switch', '-c', branch)
  commit('worker')
  git('switch', 'main')
  if (conflict) commit('operator')
  return { git, file }
}

it('requires an allowed sender and an explicit apply command before running any subprocess', async () => {
  const { host, ticket, spawn } = await completed('git')
  const unauthorized = feishu('2', 'apply', { root_id: 'om_1', sender_id: 'ou_other' })
  const unrelated = feishu('3', `@bot Please discuss apply ${ticket.id}`)
  h.runtime.receive(unauthorized)
  h.runtime.receive(unrelated)
  await expect(applyTicket(host, ticket.id, unauthorized.id)).rejects.toThrow('allowed Feishu operator')
  await expect(applyTicket(host, ticket.id, unrelated.id)).rejects.toThrow('explicitly ask to apply')
  expect(spawn).not.toHaveBeenCalled()
})

it('applies a completed ticket reopened by its own thread command and reuses the command receipt', async () => {
  const { host, ticket, project, spawn } = await completed('git')
  const { file } = projectGit(project, `agent/${ticket.execution!.name}`, false)
  const command = feishu('2', '@_user_1 应用', { root_id: 'om_1', mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Project Bot' }] })
  h.runtime.receive(command)
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  const applied = await applyTicket(host, ticket.id, command.id)
  expect(applied).toMatchObject({ applied: true, mode: 'git' })
  expect(readFileSync(file, 'utf8')).toBe('worker')
  const calls = spawn.mock.calls.length
  expect(await applyTicket(host, ticket.id, command.id)).toEqual(applied)
  expect(spawn).toHaveBeenCalledTimes(calls)
})

it('aborts its own conflicting merge and leaves the original checkout clean', async () => {
  const { host, ticket, project } = await completed('git')
  const { git, file } = projectGit(project, `agent/${ticket.execution!.name}`, true)
  const before = git('rev-parse', 'HEAD')
  const command = feishu('2', `@bot apply ${ticket.id.slice(0, 6)}`)
  h.runtime.receive(command)
  await expect(applyTicket(host, ticket.id, command.id)).rejects.toThrow()
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(git('status', '--porcelain')).toBe('')
  expect(readFileSync(file, 'utf8')).toBe('operator')
})

it.skipIf(spawnSync('rsync', ['--version']).status !== 0)('refuses a stale copy and applies it when the project matches the snapshot', async () => {
  const { host, ticket, project } = await completed('copy')
  const { name, directory } = ticket.execution!
  const snapshots = join(host.stateDir, 'snapshots')
  mkdirSync(snapshots)
  writeFileSync(join(project, 'work.txt'), 'base')
  execFileSync('tar', ['-czf', join(snapshots, `${name}.tar.gz`), '-C', project, '.'])
  writeFileSync(join(directory, 'work.txt'), 'worker')
  const extra = join(project, 'operator.txt')
  writeFileSync(extra, 'new')
  const command = feishu('2', `@bot apply ${ticket.id}`)
  h.runtime.receive(command)
  await expect(applyTicket(host, ticket.id, command.id)).rejects.toThrow('project has changed')
  expect(readFileSync(extra, 'utf8')).toBe('new')
  expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('base')

  unlinkSync(extra)
  await expect(applyTicket(host, ticket.id, command.id)).resolves.toMatchObject({ applied: true, mode: 'copy' })
  expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('worker')
})
