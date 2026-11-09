/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment, Project } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
  { key: 'DSH_SUPERAGENT_PROJECT', ticket: true, description: { zh: '这个工单对应的本地项目名', en: 'The local project this ticket works on' } },
  { key: 'DSH_SUPERAGENT_PROJECT_PATH', ticket: true, description: { zh: '本地项目的原始路径；工单目录由它准备而来，不要直接修改它', en: 'The local project folder this ticket was prepared from; do not modify it directly' } },
  { key: 'DSH_SUPERAGENT_PROJECT_MODE', ticket: true, description: { zh: '项目模式：git 为每单 worktree + 分支，copy 为每单副本', en: 'Project mode: git prepares a worktree and branch per ticket, copy prepares a copy' } },
  { key: 'DSH_SUPERAGENT_ARTIFACTS', ticket: true, description: { zh: '把 result.md、diff、截图等给用户看的附件写进这个目录', en: 'Write user-facing attachments such as result.md, diffs and screenshots into this directory' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string; artifacts?: string };
  project?: Project; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, project, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '),
    ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
      ...ticket.artifacts ? { DSH_SUPERAGENT_ARTIFACTS: ticket.artifacts } : {} } : {},
    ...project ? { DSH_SUPERAGENT_PROJECT: project.name, DSH_SUPERAGENT_PROJECT_PATH: project.path, DSH_SUPERAGENT_PROJECT_MODE: project.mode } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket;
  project?: Project; artifacts?: string; trigger?: Trigger }) {
  const { ticket, project, artifacts, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '', ...artifacts ? { artifacts } : {} }
  return environmentOf({ ...rest, ticket: values, ...project ? { project } : {}, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
