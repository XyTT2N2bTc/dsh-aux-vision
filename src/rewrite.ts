/**
 * 图片检测与消息重写（纯函数，可单测）。
 *
 * 语义对齐 dsh-llm 的 contentHasImage：递归深入 tool-result 内容；
 * 重写把 image 块原位替换为 text 块（描述或占位），其余块不动。
 */

import type { ContentBlockLike, ImageAttachmentRef, UserMessageLike } from './types.js'

/** 一个待处理的图片出现点。 */
export interface ImageOccurrence {
  /** 所在消息下标。 */
  message: number
  /** 所在内容块下标。 */
  block: number
  /** 持久化图片引用。 */
  ref: ImageAttachmentRef
  /** 所在消息的文本拼接（作为视觉提示的上下文）。 */
  context: string
}

/** 递归检测内容块是否含 image。 */
export function blocksHaveImage(content: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; content?: unknown }
    if (candidate.type === 'image') return true
    if (Array.isArray(candidate.content) && blocksHaveImage(candidate.content)) return true
  }
  return false
}

/** 任一消息含 image 块。 */
export function messagesHaveImage(messages: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some(message =>
    message !== null && typeof message === 'object' && blocksHaveImage((message as { content?: unknown }).content as readonly unknown[] | undefined))
}

/** 拼接消息内的文本块（递归 tool-result 嵌套，工具结果信封文本也算），作为视觉提示的上下文。 */
export function textOfContent(content: readonly ContentBlockLike[]): string {
  const parts: string[] = []
  const walk = (blocks: readonly ContentBlockLike[]): void => {
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      if (Array.isArray(block.content)) walk(block.content)
    }
  }
  walk(content)
  return parts.join('\n').trim()
}

/**
 * 在会话事件里按 attachmentId 查找图片引用（vision_ask 等按 id 追问时用）。
 * 递归深入 tool-result 嵌套；返回第一个匹配的引用。
 */
export function findImageRefInEvents(
  events: readonly unknown[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  const walk = (blocks: readonly ContentBlockLike[]): ImageAttachmentRef | undefined => {
    for (const block of blocks) {
      if (block.type === 'image' && block.attachment !== undefined && block.attachment.attachmentId === attachmentId) {
        return block.attachment
      }
      if (Array.isArray(block.content)) {
        const nested = walk(block.content)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = (event as { data?: { message?: { content?: readonly ContentBlockLike[] }; content?: readonly ContentBlockLike[] } }).data
    const content = data?.message?.content ?? data?.content
    if (Array.isArray(content)) {
      const hit = walk(content)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** 收集全部图片出现点（递归，含 tool-result 嵌套）。 */
export function collectImages(messages: readonly UserMessageLike[]): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = []
  messages.forEach((message, messageIndex) => {
    if (!blocksHaveImage(message.content)) return
    const context = textOfContent(message.content)
    const walk = (blocks: readonly ContentBlockLike[]): void => {
      blocks.forEach((block, blockIndex) => {
        if (block.type === 'image' && block.attachment !== undefined) {
          occurrences.push({ message: messageIndex, block: blockIndex, ref: block.attachment, context })
        } else if (Array.isArray(block.content)) {
          walk(block.content)
        }
      })
    }
    walk(message.content)
  })
  return occurrences
}

/**
 * 用异步描述函数重写含图消息：每个 image 块原位替换为 `describe` 返回的文本块。
 * 重写失败（describe 抛错）的图片保持原样，由调用方决定是否整体降级。
 * @returns 重写后的消息列表与是否发生变更。
 */
export async function rewriteImageMessages(
  messages: readonly UserMessageLike[],
  describe: (occurrence: ImageOccurrence) => Promise<string>,
): Promise<{ messages: readonly UserMessageLike[]; changed: boolean }> {
  const occurrences = collectImages(messages)
  if (occurrences.length === 0) return { messages, changed: false }
  const replacements = new Map<number, Map<number, string>>()
  for (const occurrence of occurrences) {
    let perMessage = replacements.get(occurrence.message)
    if (perMessage === undefined) {
      perMessage = new Map()
      replacements.set(occurrence.message, perMessage)
    }
    perMessage.set(occurrence.block, await describe(occurrence))
  }
  const out = messages.map((message, messageIndex) => {
    const perMessage = replacements.get(messageIndex)
    if (perMessage === undefined) return message
    const rewriteBlocks = (blocks: readonly ContentBlockLike[], offset: number): ContentBlockLike[] => {
      return blocks.map((block, index) => {
        const replacement = perMessage.get(offset + index)
        if (replacement !== undefined) return { type: 'text', text: replacement }
        if (Array.isArray(block.content)) {
          return { ...block, content: rewriteBlocks(block.content, 0) }
        }
        return block
      })
    }
    return { ...message, content: rewriteBlocks(message.content, 0) } as UserMessageLike
  })
  return { messages: out, changed: true }
}

/**
 * 视觉名额分配（batchMaxImages 的「未命中优先」语义）：
 * - 缓存命中的图不占名额（本来就不用调模型，直接取缓存描述）；
 * - 同一 attachmentId 多次出现只占一次名额（首处描述后其余走缓存）；
 * - 未命中且名额耗尽 → overflow（占位），并返回其 attachmentId 供日志。
 */
export interface VisionBudgetPlan {
  /** 应走描述流程的 occurrence key 集合（命中缓存 + 获得名额）。 */
  describedKeys: ReadonlySet<string>
  /** 溢出（占位）的 attachmentId 列表。 */
  overflow: readonly string[]
}

/** occurrence 稳定 key（同输入消息列表内确定）。 */
export function occurrenceKey(occurrence: ImageOccurrence): string {
  return `${occurrence.message}:${occurrence.block}:${occurrence.ref.attachmentId}`
}

export function planVisionBudget(
  occurrences: readonly ImageOccurrence[],
  isCached: (occurrence: ImageOccurrence) => boolean,
  budget: number,
): VisionBudgetPlan {
  const describedKeys = new Set<string>()
  const overflow: string[] = []
  let remaining = budget
  const seenAttachmentIds = new Set<string>()
  for (const occurrence of occurrences) {
    const cached = isCached(occurrence)
    const duplicate = seenAttachmentIds.has(occurrence.ref.attachmentId)
    seenAttachmentIds.add(occurrence.ref.attachmentId)
    if (cached || duplicate) {
      describedKeys.add(occurrenceKey(occurrence))
      continue
    }
    if (remaining > 0) {
      remaining -= 1
      describedKeys.add(occurrenceKey(occurrence))
    } else {
      overflow.push(occurrence.ref.attachmentId)
    }
  }
  return { describedKeys, overflow }
}
