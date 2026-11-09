/** Applies a local-project ticket after validating the operator's original command. */
import { mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { latestAssignment, latestReport, type Ticket } from '../core/index.ts'
import type { Project } from '../deployment.ts'
import { runAsWorker } from '../infra/environment.ts'
import { withinDirectory } from '../infra/paths.ts'
import { KV } from '../kv.ts'
import { allowedSender } from '../policy.ts'
import type { Store } from './store.ts'

export interface ApplyHost {
  readonly context: Pick<Context, 'subprocess'>
  readonly stateDir: string
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'get' | 'set'>
  readonly project: (ticket: Ticket) => Project | undefined
  readonly feishuBotName: () => string | undefined
}

export type ApplyResult = { applied: true; project: string } & (
  { mode: 'git'; branch: string; output: string } | { mode: 'copy'; backup: string })

const applying = new Set<string>()

function authorize(host: ApplyHost, ticket: Ticket, triggerId: string): void {
  const trigger = host.store.triggers.get(triggerId)
  const settings = host.store.settings()
  if (settings.paused || settings.sources.feishu?.enabled === false
    || !trigger?.human || trigger.source !== 'feishu' || !trigger.channel || !allowedSender(settings, trigger.actor)) {
    throw new Error('Apply requires a command from an allowed Feishu operator while processing is active')
  }
  let text = trigger.text.trim()
  const bot = host.feishuBotName()
  const mention = typeof trigger.meta.botMention === 'string' ? trigger.meta.botMention : bot ? `@${bot}` : ''
  if (trigger.meta.mentioned && mention && text.startsWith(mention)) {
    text = text.slice(mention.length).trimStart()
  }
  const command = /^(?:应用|合并|apply)(?:\s+#?([a-f0-9]{6}|[a-f0-9]{32}))?$/i.exec(text)
  const target = command?.[1]?.toLowerCase()
  const received = (item: Ticket) => item.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId && !input.context)
  const belongs = received(ticket)
  if (!command || (target ? !ticket.id.startsWith(target) : !belongs)) throw new Error('The original message must explicitly ask to apply this ticket')
  if ((!target || target.length === 6) && host.store.tickets.list().filter(target ? item => item.id.startsWith(target) : received).length !== 1) {
    throw new Error('The command could apply more than one ticket. Ask the operator to use the full ID.')
  }
}

function readyToApply(ticket: Ticket, triggerId: string): boolean {
  if (ticket.ended) return ticket.ended.outcome === 'completed'
  const assignment = latestAssignment(ticket)
  if (assignment?.report) return assignment.report.state === 'ready'
  // An apply message on the ticket's thread reopens it before reaching the worker.
  const resumed = ticket.inputs.findLast(input => input.kind === 'resumed')
  const report = latestReport(ticket)
  return !!assignment && report?.state === 'ready' && resumed?.triggerId === triggerId
    && !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context
      && input.triggerId !== triggerId && input.at > report.at)
}

type LocalCommand = (argv: string[]) => Promise<string>

async function applyGit(run: LocalCommand, project: string, name: string, verify: () => void): Promise<ApplyResult> {
  const git = (...args: string[]) => run(['git', ...args])
  const mergeHead = () => git('rev-parse', '--verify', '-q', 'MERGE_HEAD').then(head => head.trim(), () => '')
  if (await mergeHead() || (await git('status', '--porcelain')).trim()) {
    throw new Error('The project checkout is busy or has uncommitted changes. Finish or abort any merge, then commit or stash local changes.')
  }
  const branch = `agent/${name}`
  const commit = (await git('rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
    .catch(() => { throw new Error(`The ticket branch ${branch} does not exist in ${project}`) })).trim()
  verify()
  try {
    const output = await git('-c', 'user.name=dsh-superagent', '-c', 'user.email=ticket@dsh.local', 'merge', '--no-edit', '--no-autostash', commit)
    return { applied: true, mode: 'git', project, branch, output: output.trim().split('\n').slice(-3).join('\n') }
  } catch (error) {
    if (await mergeHead() === commit) {
      await git('merge', '--abort').catch(abort => {
        throw new Error(`Apply failed and Git could not abort the merge: ${String(error)}. Abort failed: ${String(abort)}`)
      })
    }
    throw error
  }
}

async function applyCopy(run: LocalCommand, stateDir: string, project: string, name: string, directory: string,
  verify: () => void): Promise<ApplyResult> {
  const backups = join(stateDir, 'snapshots')
  const snapshot = join(backups, `${name}.tar.gz`)
  const baseline = await mkdtemp(join(backups, 'baseline-'))
  const backup = join(backups, `${name}-apply-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`)
  const sync = ['rsync', '-a', '--checksum', '--delete', '--exclude=.git']
  try {
    await run(['tar', '-xzpf', snapshot, '-C', baseline]).catch(error => {
      throw new Error(`The ticket's original snapshot could not be read: ${String(error)}`)
    })
    await run(['tar', '-czf', backup, '-C', project, '.'])
    try {
      const changed = await run([...sync, '--dry-run', '--itemize-changes', '--omit-dir-times', `${baseline}/`, `${project}/`])
      if (changed.trim()) throw new Error('The project has changed since this ticket started. Review the ticket diff before applying it.')
      verify()
    } catch (error) {
      await unlink(backup).catch(() => {})
      throw error
    }
    await run([...sync, `${directory}/`, `${project}/`])
    return { applied: true, mode: 'copy', project, backup }
  } finally {
    await rm(baseline, { recursive: true, force: true }).catch(() => { /* Cleanup must not mask the apply outcome. */ })
  }
}

export async function applyTicket(host: ApplyHost, ticketId: string, triggerId: string): Promise<ApplyResult> {
  const ticket = host.store.tickets.get(ticketId)
  if (!ticket) throw new Error('Unknown ticket: ' + ticketId)
  authorize(host, ticket, triggerId)
  const receipt = KV.feishu.applied(triggerId, ticketId)
  const prior = host.store.get(receipt)
  if (prior) return prior
  const project = host.project(ticket)
  if (!project || !ticket.execution) throw new Error('This ticket has no prepared local project workspace')
  const { name, directory } = ticket.execution
  const verify = () => {
    const current = host.store.tickets.get(ticketId)
    if (!current || !readyToApply(current, triggerId)) throw new Error('Only ready or completed work can be applied')
    authorize(host, current, triggerId)
  }
  verify()
  const path = await realpath(project.path)
  if (applying.has(path)) throw new Error('Another ticket is applying changes to this project')
  applying.add(path)
  try {
    // A concurrent invocation may have finished while this one resolved the project path.
    const existing = host.store.get(receipt)
    if (existing) return existing
    const run: LocalCommand = argv => runAsWorker(host.context.subprocess, argv, path, AbortSignal.timeout(120_000))
    let result: ApplyResult
    if (project.mode === 'git') result = await applyGit(run, path, name, verify)
    else {
      const work = await realpath(directory)
      if (withinDirectory(path, work) || withinDirectory(work, path) || withinDirectory(path, await realpath(host.stateDir))) {
        throw new Error('The project must be separate from the ticket workspace and must not contain the state directory')
      }
      await mkdir(join(host.stateDir, 'snapshots'), { recursive: true })
      result = await applyCopy(run, host.stateDir, path, name, work, verify)
    }
    host.store.set(receipt, result)
    return result
  } finally {
    applying.delete(path)
  }
}
