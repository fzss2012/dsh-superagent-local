/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
// The explicit `any` hides schemastery's internal inferred type, which is not portable across .d.ts emit; the shape is `DeploymentConfig`.
export const Config: any = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  /** Local-project mode: when this list is not empty, dsh-superagent needs no GitHub repository. Each project is a folder on this machine. */
  projects: s.array(s.object({
    name: s.string().required().description('Short name used in logs and ticket short names.'),
    path: absolute('Local project folder the tickets for this chat work on.'),
    mode: s.string().default('git')
      .description('git: prepare a git worktree and branch per ticket; copy: snapshot the folder and work on a copy. Validated as git or copy.'),
    chatId: s.string().pattern(/^(oc_[A-Za-z0-9]+)?$/).default('').description('Feishu chat id (oc_...) whose tickets work on this project. Empty marks the default project.'),
    base: s.string().default('').description('git mode: commit-ish to branch the ticket worktree from; empty uses HEAD.'),
    prepare: s.string().default('').description('Optional prepare command overriding the built-in git worktree or copy preparation.'),
  })).default([]).description('Local project folders served when no GitHub repository is involved. A non-empty list selects local-project mode.'),
})
export interface DeploymentConfig {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  projects: Project[]
}
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  /** Local project folders served when no GitHub repository is involved. Empty means repository mode. */
  projects: Project[]
}
/** One local project folder served in local-project mode. */
export interface Project { name: string; path: string; mode: 'git' | 'copy'; chatId: string; base: string; prepare: string }
/** True when this installation serves local project folders instead of a GitHub repository. */
export const localMode = (machine: Pick<Machine, 'projects'>): boolean => machine.projects.length > 0
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, projects } = config
  const parsed = ProjectListSchema.parse(projects ?? [])
  const paths = new Set<string>(), names = new Set<string>()
  for (const project of parsed) {
    if (paths.has(project.path)) throw new Error(`dsh-superagent projects list repeats the path ${project.path}`)
    if (names.has(project.name)) throw new Error(`dsh-superagent projects list repeats the name ${project.name}`)
    paths.add(project.path); names.add(project.name)
  }
  const defaults = parsed.filter(project => !project.chatId)
  if (defaults.length > 1) throw new Error('dsh-superagent projects list has more than one default project (an entry with an empty chatId)')
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, projects: parsed }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
export const ProjectSchema = z.object({
  name: z.string().trim().min(1).max(60),
  path: z.string().trim().regex(/^\//, 'Absolute path'),
  mode: z.enum(['git', 'copy']),
  chatId: z.string().trim().regex(/^oc_[A-Za-z0-9]+$/, 'oc_...').or(z.literal('')),
  base: z.string().trim().default(''),
  prepare: z.string().trim().default(''),
}).strict()
export const ProjectListSchema = z.array(ProjectSchema)
/** A project whose chat or path matches a trigger's Feishu chat, falling back to the single default project. */
export function projectForChat(projects: readonly Project[], chatId: string | undefined): Project | undefined {
  return (chatId ? projects.find(project => project.chatId === chatId) : undefined) ?? projects.find(project => !project.chatId)
}
/** Verify that every configured local project exists and, in git mode, is inside a git work tree. */
export async function verifyLocalProjects(machine: Machine, probe: Probe): Promise<void> {
  for (const project of machine.projects) {
    const directory = resolvePath(project.path)
    try { if (!statSync(directory).isDirectory()) throw new Error('not a directory') }
    catch { throw new SetupError('projectMissing', { name: project.name, path: directory }) }
    if (project.mode !== 'git') continue
    const inside = await probe(['git', '-C', directory, 'rev-parse', '--is-inside-work-tree']).then(text => text.trim() === 'true', () => false)
    if (!inside) throw new SetupError('projectNotGit', { name: project.name, path: directory })
  }
}
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  /** The GitHub repository in repository mode; empty in local-project mode, where no GitHub Source is installed. */
  repository: string
  /** The agent GitHub account in repository mode; empty strings in local-project mode, where GitHub commands are unavailable. */
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
