/**
 * 视觉目标选择（配置链 + 自动发现）与视觉调用。
 *
 * 完全复用 llm 服务管线（prepareCall + 流式协议），不重复实现 provider 适配；
 * 视觉调用是手建请求（不带 agent-loop 标记），不会进入会话日志。
 */

import type {
  GenerateOptionsLike,
  ImageAttachmentRef,
  LlmCallConfigLike,
  LlmServiceLike,
  PreparedCallLike,
  StreamChunkLike,
} from './types.js'
import type { ResolveModelInfo } from './capability.js'

/** 视觉候选（任意已注册 provider 中声明 image 能力的模型）。 */
export interface VisionCandidate {
  provider: string
  model: string
}

/** 视觉目标选择器：配置链优先，自动发现兜底。 */
export class VisionTargets {
  private discovered: VisionCandidate[] | undefined

  constructor(
    /** 判定模态一律用补丁前的原方法（补丁会让一切模型都申报 image，不可用于判定）。 */
    private readonly resolveOriginal: ResolveModelInfo,
    private readonly llm: LlmServiceLike,
    private readonly chain: readonly VisionCandidate[],
    private readonly discoveryEnabled: boolean,
  ) {}

  /** 适配器/目录变更后使发现缓存失效（由调用方挂在 llm/adapters-updated 上）。 */
  invalidate(): void {
    this.discovered = undefined
  }

  /** 返回第一个可用候选；全部不可用返回 undefined。 */
  async pick(): Promise<VisionCandidate | undefined> {
    for (const candidate of this.chain) {
      if (await this.usable(candidate)) return candidate
    }
    if (!this.discoveryEnabled) return undefined
    if (this.discovered === undefined) await this.refresh()
    for (const candidate of this.discovered ?? []) {
      if (await this.usable(candidate)) return candidate
    }
    return undefined
  }

  /** 候选可用 = 有适配器（resolve 不抛 NO_ADAPTER）且原方法声明 image。 */
  private async usable(candidate: VisionCandidate): Promise<boolean> {
    try {
      const info = await this.resolveOriginal(candidate.provider, candidate.model)
      return info.inputModalities?.includes('image') ?? false
    } catch {
      return false
    }
  }

  /** 扫描所有已注册 provider 的目录，收集声明 image 的模型（错误跳过单个 provider）。 */
  private async refresh(): Promise<void> {
    const out: VisionCandidate[] = []
    try {
      const providers = this.llm.listProviders()
      for (const provider of providers) {
        try {
          const models = await this.llm.listModels(provider.id)
          for (const model of models) {
            if (model.inputModalities?.includes('image')) {
              out.push({ provider: provider.id, model: model.id })
            }
          }
        } catch {
          // 单个 provider 的目录失败不阻塞发现。
        }
      }
    } catch {
      // listProviders 失败视为无目录可扫。
    }
    this.discovered = out
  }
}

/** 最小流式装配器：收集 text 块，finish 时抛出失败或返回全文。 */
export class TextAssembler {
  private parts = new Map<number, string>()
  private order: number[] = []
  private finishReason: StreamChunkLike | undefined

  push(chunk: StreamChunkLike): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.parts.has(chunk.index)) {
          this.order.push(chunk.index)
          this.parts.set(chunk.index, '')
        }
        return
      }
      case 'text-delta': {
        const current = this.parts.get(chunk.index)
        this.parts.set(chunk.index, (current ?? '') + chunk.text)
        return
      }
      case 'block-end': {
        if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          this.parts.set(chunk.index, chunk.block.text)
        }
        return
      }
      case 'finish':
      case 'error':
      case 'aborted': {
        this.finishReason = chunk
        return
      }
      default:
        return
    }
  }

  /**
   * 装配完成：非正常 finish（error/aborted）抛错；否则返回所有 text 块拼接。
   * max-tokens 截断视为可用部分输出（由调用方判空）。
   */
  finish(): string {
    const reason = this.finishReason
    if (reason !== undefined) {
      if (reason.type === 'finish' && (reason.reason.kind === 'error' || reason.reason.kind === 'aborted')) {
        throw new Error(
          `vision call failed: ${reason.reason.kind === 'error' ? reason.reason.failure.code : 'aborted'} ${reason.reason.failure.message}`,
        )
      }
      if (reason.type === 'error' || reason.type === 'aborted') {
        throw new Error(`vision call failed: ${reason.type} ${reason.failure.message}`)
      }
    }
    return this.order.map(index => this.parts.get(index) ?? '').join('').trim()
  }
}

/** 一次视觉调用：mimo 等视觉模型看原图像素，返回描述文本。 */
export async function describeImage(
  llm: LlmServiceLike,
  candidate: VisionCandidate,
  ref: ImageAttachmentRef,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted === true) throw new Error('aux-vision: turn aborted before the vision call')
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new Error(`aux-vision: vision call to ${candidate.provider}/${candidate.model} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const fused = signal === undefined
    ? timeout.signal
    : AbortSignal.any([signal, timeout.signal])
  try {
    const config: LlmCallConfigLike = {
      provider: candidate.provider,
      model: candidate.model,
      maxTokens,
    }
    const prepared: PreparedCallLike = await llm.prepareCall(config, fused)
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: prompt },
        ],
        source: { kind: 'plugin', plugin: 'dsh-aux-vision' },
      },
    ]
    const assembler = new TextAssembler()
    for await (const chunk of prepared.stream({ ...config, messages, signal: fused })) {
      assembler.push(chunk)
    }
    const text = assembler.finish()
    if (text === '') throw new Error(`aux-vision: vision model ${candidate.model} returned empty output`)
    return text
  } finally {
    clearTimeout(timer)
  }
}
