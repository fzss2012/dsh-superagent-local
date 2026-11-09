/** Outbox delivery when processing is paused or a Source kind registers late. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { deferred, track, waitUntil } from './fixtures/async.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('resumes Feishu delivery at the first failed part and gives each reply distinct attachment keys', async () => {
  const artifact = join(h.runtime.machine.stateDir, 'result.md')
  const screenshot = join(h.runtime.machine.stateDir, 'screenshot-before.png')
  writeFileSync(artifact, 'result')
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  const message: OutboundMessage = { id: 'result', channel: feishu('a'.repeat(32), 'x').channel!, text: 'Ready', kind: 'reply',
    attachments: [{ path: artifact }, { path: screenshot }] }
  h.runtime.outbox.send(message)
  await h.runtime.sendReplies()
  expect(h.runtime.store.receipts.get(message.id)).toMatchObject({ status: 'pending', nextPart: 2, partAttemptedAt: null })
  const calls = () => lark.mock.calls.map(([args]) => args).filter(args => args.includes('+messages-reply'))
  expect(calls()).toHaveLength(2)
  writeFileSync(screenshot, 'image')
  await at(3_605_000)
  expect(h.runtime.outbox.status(message.id)).toBe('sent')
  expect(calls()).toHaveLength(3)
  expect(calls().at(-1)).toContain('--image')
  const keys = () => calls().map(args => args[args.indexOf('--idempotency-key') + 1])
  h.runtime.outbox.send({ ...message, id: 'detail', attachments: [{ path: artifact }] })
  await h.runtime.sendReplies()
  expect(keys().at(-1)).not.toBe(keys()[1])
  expect(keys().every(key => key && key.length <= 50)).toBe(true)
})

it('reuses a Feishu key within the retry window and stops after an unconfirmed attempt ages out', async () => {
  const { runtime } = h
  const lark = vi.mocked(Commands.prototype.lark)
  const calls = () => lark.mock.calls.map(([args]) => args).filter(args => args.includes('+messages-reply'))
  lark.mockClear()
  lark.mockRejectedValue(new Error('Connection closed before Feishu delivery could be confirmed'))
  const id = 'unconfirmed'
  runtime.outbox.send({ id, channel: feishu('1', 'x').channel!, text: 'Ready', kind: 'reply' })
  await runtime.sendReplies()
  const attempt = runtime.store.receipts.get(id)?.partAttemptedAt
  expect(attempt).toEqual(expect.any(Number))
  expect(calls()).toHaveLength(1)
  await at(5000)
  expect(calls()).toEqual([calls()[0], calls()[0]])
  expect(runtime.store.receipts.get(id)?.partAttemptedAt).toBe(attempt)
  await at(3_605_000)
  expect(calls()).toHaveLength(2)
  expect(runtime.store.receipts.get(id)).toMatchObject({ status: 'dropped', dropped: { reason: 'deliveryUnconfirmed' } })
  expect(runtime.effects.pending('reply', id)).toBe(false)
})

it('settles a confirmed text reply without resending when the final receipt write is retried', async () => {
  const { runtime } = h
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  vi.spyOn(runtime.store.receipts, 'settle').mockImplementationOnce(() => { throw new Error('Database write failed') })
  const id = 'confirmed'
  runtime.outbox.send({ id, channel: feishu('1', 'x').channel!, text: 'Ready', kind: 'reply' })
  await runtime.sendReplies()
  expect(runtime.store.receipts.get(id)).toMatchObject({ status: 'pending', nextPart: 1, partAttemptedAt: null })
  await at(3_605_000)
  expect(runtime.outbox.status(id)).toBe('sent')
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(1)
})

it('holds old pending Feishu replies with unknown delivery and settles old fully confirmed replies', async () => {
  const { runtime } = h
  await runtime.settings.pause(true, 'panel')
  const channel = feishu('1', 'x').channel!
  const file = join(runtime.machine.stateDir, 'result.md')
  writeFileSync(file, 'result')
  runtime.outbox.send({ id: 'old-unknown', channel, text: 'Ready', kind: 'reply', attachments: [{ path: file }] })
  runtime.outbox.send({ id: 'old-confirmed', channel, text: 'Ready', kind: 'reply', attachments: [{ path: file }] })
  runtime.store.db.prepare("UPDATE outbox SET value = json_remove(value, '$.partAttemptedAt') WHERE id IN (?, ?)")
    .run('old-unknown', 'old-confirmed')
  runtime.store.db.prepare("UPDATE outbox SET value = json_set(value, '$.nextPart', 2) WHERE id = ?").run('old-confirmed')
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  await runtime.settings.pause(false, 'panel')
  await runtime.sendReplies()
  expect(runtime.store.receipts.get('old-unknown')).toMatchObject({ status: 'dropped', dropped: { reason: 'deliveryUnconfirmed' } })
  expect(runtime.outbox.status('old-confirmed')).toBe('sent')
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(0)
  expect(runtime.effects.pending('reply')).toBe(false)
})

it('finishes waiting for a sent reply while a later unrelated send is running', async () => {
  const gate = deferred()
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockImplementation(async args => { if (args.includes('slow')) await gate.promise; return {} })
  const message = (id: string): OutboundMessage => ({ id, channel: feishu(id, 'x').channel!, text: id, kind: 'reply' })
  h.runtime.outbox.send(message('fast'))
  h.runtime.outbox.send(message('slow'))
  const done = track(h.runtime.outbox.sent('fast'))
  try {
    await waitUntil(() => done.settled)
    expect(h.runtime.outbox.status('fast')).toBe('sent')
    expect(h.runtime.outbox.status('slow')).toBe('pending')
  } finally {
    gate.resolve()
    await h.runtime.sendReplies()
  }
})
