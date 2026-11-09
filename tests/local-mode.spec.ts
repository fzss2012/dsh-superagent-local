/** Local-project mode: project registry parsing, chat matching, and setup verification. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, machineOf, projectForChat, verifyLocalProjects, type Machine, type Project } from '../src/deployment.ts'
import { SetupError } from '../src/setup.ts'

const dirs: string[] = []
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dsh-local-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const project = (overrides: Partial<Project> = {}): Project => ({ name: 'demo', path: '/tmp/demo', mode: 'git', chatId: '', base: '', prepare: '', ...overrides })

describe('local projects configuration', () => {
  it('parses a projects list and defaults mode to copy only through the schema defaults', () => {
    const dir = temp()
    const machine = machineOf(Config({ stateDir: dir, projects: [
      { name: 'a', path: dir, mode: 'git', chatId: 'oc_aaa' },
      { name: 'b', path: join(dir, 'b'), mode: 'copy' },
    ] }))
    expect(machine.projects).toEqual([
      { name: 'a', path: dir, mode: 'git', chatId: 'oc_aaa', base: '', prepare: '' },
      { name: 'b', path: join(dir, 'b'), mode: 'copy', chatId: '', base: '', prepare: '' },
    ])
  })
  it('refuses duplicate paths, duplicate names, more than one default project, and unknown modes', () => {
    const dir = temp()
    expect(() => machineOf(Config({ stateDir: dir, projects: [project({ name: 'a', path: dir }), project({ name: 'b', path: dir })] })))
      .toThrow('repeats the path')
    expect(() => machineOf(Config({ stateDir: dir, projects: [project({ name: 'a', path: dir }), project({ name: 'a', path: join(dir, 'x') })] })))
      .toThrow('repeats the name')
    expect(() => machineOf(Config({ stateDir: dir, projects: [project({ name: 'a', path: dir }), project({ name: 'b', path: join(dir, 'x') })] })))
      .toThrow('more than one default project')
    expect(() => machineOf(Config({ stateDir: dir, projects: [project({ mode: 'svn' as never })] }))).toThrow()
  })
  it('matches a chat id exactly and falls back to the single default project', () => {
    const projects = [project({ name: 'default', path: '/tmp/default' }), project({ name: 'a', path: '/tmp/a', chatId: 'oc_aaa' })]
    expect(projectForChat(projects, 'oc_aaa')?.name).toBe('a')
    expect(projectForChat(projects, 'oc_other')?.name).toBe('default')
    expect(projectForChat([project({ name: 'a', chatId: 'oc_aaa' })], 'oc_other')).toBeUndefined()
  })
})

describe('local project setup verification', () => {
  it('accepts existing folders, checks git work trees only in git mode, and names missing folders', async () => {
    const dir = temp()
    const gitDir = join(dir, 'git')
    const copyDir = join(dir, 'copy')
    mkdirSync(gitDir); mkdirSync(copyDir)
    const machine: Machine = { stateDir: join(dir, 'state'), promptMaxChars: { get: () => 1 } as never,
      admissionContextMaxPages: { get: () => 1 } as never, admissionContextTimeoutMs: { get: () => 1 } as never,
      projects: [project({ name: 'git', path: gitDir, mode: 'git' }), project({ name: 'copy', path: copyDir, mode: 'copy' })] }
    const answers = new Map([[gitDir, 'true']])
    const probe = async (argv: string[]) => { const path = argv[argv.indexOf('-C') + 1] ?? ''; return answers.get(path) ?? 'false' }
    await expect(verifyLocalProjects(machine, probe)).resolves.toBeUndefined()
    answers.set(gitDir, 'false')
    await expect(verifyLocalProjects(machine, probe)).rejects.toBeInstanceOf(SetupError)
    machine.projects = [project({ name: 'missing', path: join(dir, 'nope'), mode: 'copy' })]
    await expect(verifyLocalProjects(machine, probe)).rejects.toBeInstanceOf(SetupError)
  })
})
