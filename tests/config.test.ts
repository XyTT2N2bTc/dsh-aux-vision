import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'

function parse(raw: unknown): ReturnType<typeof Config['~standard']['validate']> {
  return Config['~standard'].validate(raw)
}

describe('Config', () => {
  it('applies defaults when config is absent', () => {
    const result = parse(undefined)
    assert.equal(result.issues, undefined)
    assert.deepEqual(result.value, {
      enabled: true,
      declareImageCapability: true,
      visionChain: [{ provider: 'opencode-go', model: 'mimo-v2.5' }],
      visionDiscovery: true,
      maxTokens: 8192,
      timeoutMs: 120000,
      batchMaxImages: 4,
      onVisionFailure: 'marker',
      markerText: '[图片附件 {id}：辅助视觉模型暂不可用]',
      descriptionFormat: '[用户附图 {id}（{model}）：{description}]',
      descriptionDetail: 'standard',
      visionPromptTemplate: result.value?.visionPromptTemplate,
      cacheTtlSeconds: 3600,
      cacheMaxEntries: 200,
      debugLogPath: '',
      injectGuidance: true,
      guidanceText: result.value?.guidanceText,
      guidanceOrder: 500,
      visionAskEnabled: true,
    })
  })

  it('honors overrides and normalizes the vision chain', () => {
    const result = parse({
      visionChain: [
        { provider: 'opencode-go', model: 'mimo-v2.5' },
        { provider: 'opencode-go', model: 'qwen3.6-plus' },
        { provider: '', model: 'x' },
        { model: 'no-provider' },
        'junk',
      ],
      maxTokens: 4096,
      onVisionFailure: 'error',
      batchMaxImages: 8,
    })
    assert.equal(result.issues, undefined)
    assert.deepEqual(result.value?.visionChain, [
      { provider: 'opencode-go', model: 'mimo-v2.5' },
      { provider: 'opencode-go', model: 'qwen3.6-plus' },
    ])
    assert.equal(result.value?.maxTokens, 4096)
    assert.equal(result.value?.onVisionFailure, 'error')
    assert.equal(result.value?.batchMaxImages, 8)
  })

  it('rejects invalid numeric values', () => {
    const result = parse({ maxTokens: -1, timeoutMs: 0, batchMaxImages: 2.5, cacheMaxEntries: 'x' })
    assert.ok(result.issues !== undefined)
    assert.ok(result.issues.length >= 4)
  })

  it('rejects non-object config', () => {
    assert.ok(parse('nope').issues !== undefined)
    assert.ok(parse([1, 2]).issues !== undefined)
  })

  it('falls back to defaults on invalid onVisionFailure', () => {
    const result = parse({ onVisionFailure: 'explode' })
    assert.ok(result.issues !== undefined)
  })

  it('keeps template placeholders intact through validation', () => {
    const result = parse({ markerText: '[图 {id}]', descriptionFormat: '{model}|{description}|{id}' })
    assert.equal(result.value?.markerText, '[图 {id}]')
    assert.equal(result.value?.descriptionFormat, '{model}|{description}|{id}')
  })
})
