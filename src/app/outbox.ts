/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { DeliveryProgress } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Receipt, Store } from './store.ts'

/** Leave time for the CLI call before Feishu's one-hour idempotency window expires. */
const FEISHU_RETRY_WINDOW_MS = 55 * 60_000
/** Stops a send if its safe retry window expired during attachment preparation. */
class DeliveryUnconfirmed extends Error {}

function canSendFeishuPart(attemptedAt: number | null | undefined, now = Date.now()): boolean {
  return attemptedAt === null || (attemptedAt !== undefined && attemptedAt <= now && now - attemptedAt < FEISHU_RETRY_WINDOW_MS)
}

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Feishu sends are retried within their idempotency window. Unconfirmed older sends are held for review.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(id?: string): Promise<void> { return this.host.effects.idle('reply', id) }
  private feishuProgress(receipt: Receipt): DeliveryProgress {
    const { receipts } = this.host.store
    let attemptedAt = receipt.partAttemptedAt ?? null
    return {
      nextPart: receipt.nextPart ?? 0,
      start: () => {
        const now = Date.now()
        if (!canSendFeishuPart(attemptedAt, now)) throw new DeliveryUnconfirmed()
        if (attemptedAt === null) {
          receipts.attempt(receipt.id, now)
          attemptedAt = now
        }
      },
      sent: nextPart => {
        receipts.progress(receipt.id, nextPart)
        attemptedAt = null
      },
    }
  }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    const feishu = receipt.channel.source === 'feishu'
    if (feishu) {
      // A crash may leave a fully confirmed reply pending before the final settle write.
      if (receipt.nextPart === 1 + (receipt.attachments?.length ?? 0)) { store.receipts.settle(receipt, 'sent'); return }
      // An old receipt without an attempt record may have reached Feishu at any time.
      if (!canSendFeishuPart(receipt.partAttemptedAt)) { store.receipts.settle(receipt, 'deliveryUnconfirmed'); return }
    }
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    let result: Awaited<ReturnType<SourceRegistry['send']>>
    try {
      result = await sources.send(receipt, commands, feishu ? this.feishuProgress(receipt) : undefined)
    } catch (error) {
      if (!(error instanceof DeliveryUnconfirmed)) throw error
      store.receipts.settle(receipt, 'deliveryUnconfirmed')
      return
    }
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
