/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { key, type OutboundAttachment, type OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, DeliveryProgress } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
/** Sends one attachment as a separate thread reply; lark-cli accepts only cwd-relative local paths, so the file is copied into a temporary directory. */
async function sendAttachment(host: Pick<SourceContext, 'commands'>, messageId: string, attachment: OutboundAttachment, id: string,
  progress?: DeliveryProgress): Promise<void> {
  const name = basename(attachment.name ?? attachment.path)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-superagent-attach-'))
  try {
    const local = join(temporary, name)
    await copyFile(attachment.path, local)
    const kind = attachment.kind ?? (IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? 'image' : 'file')
    const reply = ['im', '+messages-reply', '--message-id', messageId, kind === 'image' ? '--image' : '--file', `./${name}`,
      '--reply-in-thread', '--idempotency-key', id]
    progress?.start()
    await host.commands.lark(reply, temporary)
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => { /* Best effort; the OS clears tmp. */ }) }
}
/**
 * Replies in the topic of the target message. Checkpoint each confirmed part so a failed upload retries from that part.
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage, progress?: DeliveryProgress): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const nextPart = progress?.nextPart ?? 0
  try {
    if (nextPart === 0) {
      const text = checkedImText(message.text)
      progress?.start()
      await host.commands.lark(['im', '+messages-reply', '--message-id', messageId, '--markdown', text,
        '--reply-in-thread', '--idempotency-key', message.id])
      progress?.sent(1)
    }
    const attachments = message.attachments ?? []
    for (let index = Math.max(0, nextPart - 1); index < attachments.length; index++) {
      await sendAttachment(host, messageId, attachments[index]!, key('attachment', message.id, String(index)), progress)
      progress?.sent(index + 2)
    }
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
