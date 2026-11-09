/** Applying a finished local-project ticket back to its project (git merge or copy sync). */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Project } from '../deployment.ts'
import type { Ticket } from '../core/index.ts'
import { runAsWorker } from '../infra/environment.ts'
import type { Store } from './store.ts'

export interface ApplyHost {
  readonly context: Pick<Context, 'subprocess'>
  readonly stateDir: string
  readonly store: Pick<Store, 'tickets'>
  readonly project: (ticket: Ticket) => Project | undefined
}

/** Run a local command in the operator environment with a timeout, returning stdout. */
async function local(host: ApplyHost, argv: string[], cwd: string): Promise<string> {
  return runAsWorker(host.context.subprocess, argv, cwd, AbortSignal.timeout(120_000))
}

/**
 * Apply a finished local-project ticket: git mode merges `agent/<ticket name>` into the project's current branch;
 * copy mode backs the project up and syncs the ticket copy over it. Only a ticket whose latest report is ready or that
 * already completed or ended can be applied.
 */
export async function applyTicket(host: ApplyHost, ticketId: string) {
  const ticket = host.store.tickets.get(ticketId)
  if (!ticket) throw new Error('Unknown ticket: ' + ticketId)
  const project = host.project(ticket)
  if (!project) throw new Error('This ticket has no local project; apply is available in local-project mode only')
  const name = ticket.execution?.name ?? ''
  const directory = ticket.execution?.directory ?? ''
  if (!name || !directory) throw new Error('The ticket has no prepared workspace to apply')
  const latest = ticket.assignments.at(-1)?.report
  const finished = latest?.state === 'ready' || !!ticket.ended
  if (!finished) throw new Error('Only a ticket whose latest report is ready, or one that already ended, can be applied')
  if (project.mode === 'git') {
    const status = await local(host, ['git', '-C', project.path, 'status', '--porcelain'], project.path)
    if (status.trim()) throw new Error('The project checkout has uncommitted changes; commit or stash them before applying the ticket branch')
    const branch = `agent/${name}`
    await local(host, ['git', '-C', project.path, 'rev-parse', '--verify', `refs/heads/${branch}`], project.path)
      .catch(() => { throw new Error(`The ticket branch ${branch} does not exist in ${project.path}`) })
    // The worker environment has no git identity (useConfigOnly), so pass one explicitly for the merge commit.
    const output = await local(host, ['git', '-C', project.path, '-c', 'user.name=dsh-superagent', '-c', 'user.email=ticket@dsh.local',
      'merge', '--no-edit', branch], project.path)
    return { applied: true, mode: 'git', project: project.path, branch, output: output.trim().split('\n').slice(-3).join('\n') }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backups = join(host.stateDir, 'snapshots')
  const backup = join(backups, `${name}-apply-${stamp}.tar.gz`)
  await local(host, ['sh', '-c', `mkdir -p '${backups}' && tar -czf '${backup}' -C '${project.path}' .`], project.path)
  await local(host, ['rsync', '-a', '--delete', '--exclude=.git/', `${directory}/`, `${project.path}/`], project.path)
  return { applied: true, mode: 'copy', project: project.path, backup }
}
