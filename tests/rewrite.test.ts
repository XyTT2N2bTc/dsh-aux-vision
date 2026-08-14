import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blocksHaveImage,
  collectImages,
  findImageRefInEvents,
  messagesHaveImage,
  occurrenceKey,
  planVisionBudget,
  rewriteImageMessages,
  textOfContent,
} from '../src/rewrite.js'
import type { ImageAttachmentRef, UserMessageLike } from '../src/types.js'

const REF: ImageAttachmentRef = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 100,
  width: 64,
  height: 64,
}

function userMessage(content: unknown[]): UserMessageLike {
  return { role: 'user', content: content as never, source: { kind: 'user' } }
}

describe('blocksHaveImage', () => {
  it('detects a plain image block', () => {
    assert.equal(blocksHaveImage([{ type: 'text', text: 'x' }]), false)
    assert.equal(blocksHaveImage([{ type: 'image', attachment: REF }]), true)
  })

  it('walks nested tool-result content', () => {
    const nested = [{ type: 'tool-result', content: [{ type: 'image', attachment: REF }] }]
    assert.equal(blocksHaveImage(nested), true)
  })

  it('tolerates malformed input', () => {
    assert.equal(blocksHaveImage(undefined), false)
    assert.equal(blocksHaveImage([null, 'x', 42]), false)
  })
})

describe('messagesHaveImage', () => {
  it('scans a message list', () => {
    assert.equal(messagesHaveImage([userMessage([{ type: 'text', text: 'a' }])]), false)
    assert.equal(messagesHaveImage([userMessage([{ type: 'image', attachment: REF }])]), true)
    assert.equal(messagesHaveImage(undefined), false)
  })
})

describe('textOfContent', () => {
  it('joins text blocks only', () => {
    assert.equal(
      textOfContent([
        { type: 'text', text: 'a' },
        { type: 'image', attachment: REF },
        { type: 'text', text: 'b' },
      ]),
      'a\nb',
    )
  })
})

describe('collectImages', () => {
  it('collects occurrences with context and stable indexes', () => {
    const messages = [
      userMessage([
        { type: 'text', text: '看这张图' },
        { type: 'image', attachment: REF },
      ]),
    ]
    const occurrences = collectImages(messages)
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0]?.message, 0)
    assert.equal(occurrences[0]?.block, 1)
    assert.equal(occurrences[0]?.ref.attachmentId, 'att-1')
    assert.equal(occurrences[0]?.context, '看这张图')
  })

  it('collects nested images inside tool results', () => {
    const messages = [
      userMessage([
        {
          type: 'tool-result',
          content: [
            { type: 'text', text: '<path>x.png</path>' },
            { type: 'image', attachment: { ...REF, attachmentId: 'att-2' } },
          ],
        },
      ]),
    ]
    const occurrences = collectImages(messages)
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0]?.ref.attachmentId, 'att-2')
    assert.equal(occurrences[0]?.context, '<path>x.png</path>')
  })
})

describe('rewriteImageMessages', () => {
  it('replaces image blocks in place and preserves other blocks', async () => {
    const messages = [
      userMessage([
        { type: 'text', text: '看这张图' },
        { type: 'image', attachment: REF },
      ]),
    ]
    const { messages: out, changed } = await rewriteImageMessages(messages, async (occurrence) =>
      `desc:${occurrence.ref.attachmentId}`)
    assert.equal(changed, true)
    assert.equal(out[0]?.content.length, 2)
    assert.deepEqual(out[0]?.content[0], { type: 'text', text: '看这张图' })
    assert.deepEqual(out[0]?.content[1], { type: 'text', text: 'desc:att-1' })
  })

  it('returns the same list untouched when nothing contains images', async () => {
    const messages = [userMessage([{ type: 'text', text: 'x' }])]
    const { messages: out, changed } = await rewriteImageMessages(messages, async () => 'nope')
    assert.equal(changed, false)
    assert.equal(out, messages)
  })

  it('describes each occurrence exactly once', async () => {
    const messages = [
      userMessage([{ type: 'image', attachment: REF }]),
      userMessage([{ type: 'image', attachment: { ...REF, attachmentId: 'att-3' } }]),
    ]
    const seen: string[] = []
    const { messages: out } = await rewriteImageMessages(messages, async (occurrence) => {
      seen.push(occurrence.ref.attachmentId)
      return `d:${occurrence.ref.attachmentId}`
    })
    assert.deepEqual(seen, ['att-1', 'att-3'])
    assert.deepEqual(out[0]?.content, [{ type: 'text', text: 'd:att-1' }])
    assert.deepEqual(out[1]?.content, [{ type: 'text', text: 'd:att-3' }])
  })
})

describe('planVisionBudget', () => {
  function occurrencesOf(ids: string[]): ReturnType<typeof collectImages> {
    return collectImages(ids.map((id, index) =>
      userMessage([
        { type: 'text', text: `m${index}` },
        { type: 'image', attachment: { ...REF, attachmentId: id } },
      ])))
  }

  it('caps uncached images at the budget and reports overflow', () => {
    const occurrences = occurrencesOf(['a', 'b', 'c'])
    const plan = planVisionBudget(occurrences, () => false, 2)
    assert.deepEqual(plan.overflow, ['c'])
    assert.equal(plan.describedKeys.size, 2)
    assert.ok(plan.describedKeys.has(occurrenceKey(occurrences[0]!)))
    assert.ok(plan.describedKeys.has(occurrenceKey(occurrences[1]!)))
    assert.ok(!plan.describedKeys.has(occurrenceKey(occurrences[2]!)))
  })

  it('gives cached images no budget cost — uncached images get priority', () => {
    // 命中图不占名额：budget=1 时，唯一名额给未命中图；命中图照常走描述（缓存）。
    const occurrences = occurrencesOf(['cached-a', 'fresh-b'])
    const cached = new Set(['cached-a'])
    const plan = planVisionBudget(occurrences, occ => cached.has(occ.ref.attachmentId), 1)
    assert.deepEqual(plan.overflow, [])
    assert.equal(plan.describedKeys.size, 2)
    for (const occ of occurrences) assert.ok(plan.describedKeys.has(occurrenceKey(occ)))
  })

  it('budget caps uncached images even when cached images are present', () => {
    const occurrences = occurrencesOf(['cached-a', 'fresh-b', 'fresh-c'])
    const cached = new Set(['cached-a'])
    const plan = planVisionBudget(occurrences, occ => cached.has(occ.ref.attachmentId), 1)
    assert.deepEqual(plan.overflow, ['fresh-c'])
    assert.equal(plan.describedKeys.size, 2) // cached-a + fresh-b
    assert.ok(!plan.describedKeys.has(occurrenceKey(occurrences[2]!)))
  })

  it('deduplicates repeated attachment ids against the budget', () => {
    // 同一张图出现两次（如历史折叠）只占一次名额；第二处走缓存。
    const occurrences = occurrencesOf(['dup', 'dup', 'new'])
    const plan = planVisionBudget(occurrences, () => false, 1)
    assert.deepEqual(plan.overflow, ['new'])
    assert.equal(plan.describedKeys.size, 2) // dup 两处 + new 溢出
    assert.ok(!plan.describedKeys.has(occurrenceKey(occurrences[2]!)))
  })

  it('handles a zero budget with all-cached input', () => {
    const occurrences = occurrencesOf(['a'])
    const plan = planVisionBudget(occurrences, () => true, 0)
    assert.deepEqual(plan.overflow, [])
    assert.equal(plan.describedKeys.size, 1)
  })
})

describe('findImageRefInEvents', () => {
  it('finds an image ref by attachmentId across events', () => {
    const events = [
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
      {
        type: 'user/message',
        data: {
          message: {
            content: [
              { type: 'text', text: 't' },
              { type: 'image', attachment: { ...REF, attachmentId: 'att-target' } },
            ],
          },
        },
      },
    ]
    const ref = findImageRefInEvents(events, 'att-target')
    assert.equal(ref?.attachmentId, 'att-target')
    assert.equal(findImageRefInEvents(events, 'att-missing'), undefined)
  })

  it('finds nested refs inside tool results', () => {
    const events = [
      {
        type: 'tool/result',
        data: {
          message: {
            content: [{
              type: 'tool-result',
              content: [{ type: 'text', text: 'p' }, { type: 'image', attachment: { ...REF, attachmentId: 'att-nested' } }],
            }],
          },
        },
      },
    ]
    assert.equal(findImageRefInEvents(events, 'att-nested')?.attachmentId, 'att-nested')
  })
})
