/**
 * dsh-aux-vision：DeepSeek Harness 辅助视觉插件（v0.2）。
 *
 * 机制：
 * ① capability：resolveModelInfo 对未声明 image 的模型补报 image（放行准入守卫）；
 * ② llm/stream：含图请求（用户发图 / read_image 工具结果 / 历史图片）进入文本模型时，
 *    视觉模型看原图（像素级）→ 描述文本原位替换 image 块 → 改写副本放行。
 *
 * v0.2 变更：不再拦截 agent/pre-step——原图消息直接进入会话日志，**UI 显示原图**；
 * 描述只出现在模型请求里（每请求改写；缓存命中零视觉调用、零模型开销）。
 *
 * 纯文本轮不触发任何视觉调用；原生视觉路由（会话/子代理）不干预。
 * 零运行时依赖：不 import 任何 @deepseek-ai 包，全部结构调用（见 types.js 说明）。
 */

import { appendFileSync } from 'node:fs'
import { installCapabilityDeclaration, type ResolveModelInfo } from './capability.js'
import { createTtlCache } from './cache.js'
import { Config, type AuxVisionConfig } from './config.js'
import {
  collectImages,
  findImageRefInEvents,
  messagesHaveImage,
  occurrenceKey,
  planVisionBudget,
  rewriteImageMessages,
  type ImageOccurrence,
} from './rewrite.js'
import { describeImage, describeWithQuestion, VisionTargets, type VisionCandidate } from './vision.js'
import { visionAskParameters } from './vision-ask-schema.js'
import type {
  GenerateOptionsLike,
  ImageAttachmentRef,
  LlmServiceLike,
  StreamChunkLike,
  UserMessageLike,
} from './types.js'

export { Config }
export const name = 'dsh-aux-vision'
export const inject = ['llm', 'systemPrompt', 'tools'] as const

/** cordis Context 的最小使用面。 */
interface ContextLike {
  llm: LlmServiceLike
  get<T = unknown>(key: string): T | undefined
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(fn: () => unknown, name?: string): void
  logger: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
  systemPrompt?: {
    section(input: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
  }
  tools?: { register(input: unknown): unknown }
  fs?: {
    resolve(path: string): Promise<{ displayPath: string }>
    readBytes(target: unknown, signal?: AbortSignal, cap?: number): Promise<Uint8Array>
  }
  attachments?: {
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>
  }
}

/** LOOP 构建的请求近似判定：带 sessionId 且深冻结（避免跨模块 WeakSet 依赖）。 */
function isLoopBuilt(options: GenerateOptionsLike): boolean {
  return options.sessionId !== undefined && Object.isFrozen(options)
}

/** 从请求里提取配置字段（prepareCall 的输入）。 */
function callConfigOf(options: GenerateOptionsLike): {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
} {
  const config: {
    provider: string
    model: string
    reasoningEffort?: string
    temperature?: number
    maxTokens?: number
    stop?: string[]
  } = { provider: options.provider, model: options.model }
  if (options.reasoningEffort !== undefined) config.reasoningEffort = options.reasoningEffort
  if (options.temperature !== undefined) config.temperature = options.temperature
  if (options.maxTokens !== undefined) config.maxTokens = options.maxTokens
  if (options.stop !== undefined) config.stop = options.stop
  return config
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 日志包装：同时写 cordis logger 与可选的调试文件（debugLogPath）。 */
function createLogger(logger: ContextLike['logger'], filePath: string): {
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
} {
  const write = (level: string, args: readonly unknown[]): void => {
    if (filePath === '') return
    try {
      const line = `[${new Date().toISOString()}] ${level} ${args
        .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')}\n`
      appendFileSync(filePath, line)
    } catch {
      // 调试日志失败不影响主流程。
    }
  }
  return {
    warn(...args: unknown[]) {
      logger.warn(...args)
      write('WARN', args)
    },
    info(...args: unknown[]) {
      logger.info(...args)
      write('INFO', args)
    },
  }
}

export function apply(ctx: ContextLike, rawConfig: AuxVisionConfig): void {
  const config = rawConfig
  const llm = ctx.llm
  const log = createLogger(ctx.logger, config.debugLogPath)

  // ① 能力申报补丁：放行准入守卫；原方法引用（绑定到实例）用于内部判定与视觉可用性检查。
  const { dispose, original } = installCapabilityDeclaration(llm, config.declareImageCapability)
  const originalResolve: ResolveModelInfo = original.bind(llm)
  ctx.effect(() => dispose, 'dsh-aux-vision: capability declaration')
  log.info(`mounted: capability=${config.declareImageCapability}, chain=${JSON.stringify(config.visionChain)}, discovery=${config.visionDiscovery}`)

  // ③ 系统提示引导：让主模型信任注入描述、不做像素比对（可选，默认开）。
  const systemPrompt = ctx.systemPrompt
  if (config.injectGuidance && systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    const guidanceModel = config.visionChain[0]?.model ?? '视觉模型'
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-aux-vision',
      order: config.guidanceOrder,
      text: () => config.guidanceText.replaceAll('{model}', guidanceModel),
    }), 'dsh-aux-vision: guidance section')
  }

  // 视觉目标选择（配置链 + 自动发现），适配器/目录变更时刷新。
  const targets = new VisionTargets(originalResolve, llm, config.visionChain, config.visionDiscovery)
  ctx.on('llm/adapters-updated', () => targets.invalidate())

  // 描述缓存（attachmentId + 视觉模型维度）。
  const cacheKeyOf = (candidate: VisionCandidate, attachmentId: string): string =>
    `${candidate.provider}:${candidate.model}|${attachmentId}`
  const cache = createTtlCache(config.cacheMaxEntries, config.cacheTtlSeconds * 1000)

  /** 单图描述（带缓存）。 */
  const describeOne = async (
    candidate: VisionCandidate,
    occurrence: ImageOccurrence,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const key = cacheKeyOf(candidate, occurrence.ref.attachmentId)
    const hit = cache.get(key)
    if (hit !== undefined) {
      log.info(`describe: cache hit ${key}`)
      return hit
    }
    const userText = occurrence.context === '' ? '（用户未提供额外文字）' : occurrence.context
    const prompt = config.visionPromptTemplate.replace('{user_text}', userText)
    log.info(`describe: calling ${candidate.provider}/${candidate.model} for ${occurrence.ref.attachmentId}`)
    const text = await describeImage(llm, candidate, occurrence.ref, prompt, config.maxTokens, config.timeoutMs, signal)
    cache.set(key, text)
    log.info(`describe: cached ${key} (${text.length} chars)`)
    return text
  }

  /** 占位文本（降级共用）。 */
  const markerFor = (attachmentId: string): string => config.markerText.replace('{id}', attachmentId)

  /** 按策略产出单图替换文本：成功 → 描述模板；失败 → marker 或抛错。 */
  const replacementTextFor = async (
    candidate: VisionCandidate,
    occurrence: ImageOccurrence,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    try {
      const description = await describeOne(candidate, occurrence, signal)
      return config.descriptionFormat
        .replace('{id}', occurrence.ref.attachmentId)
        .replace('{model}', candidate.model)
        .replace('{description}', description)
    } catch (error) {
      log.warn(`vision failed for attachment ${occurrence.ref.attachmentId}: ${errorMessage(error)}`)
      if (config.onVisionFailure === 'error') throw error
      return markerFor(occurrence.ref.attachmentId)
    }
  }

  // ② 注入路径：llm/stream。
  // 含图请求（用户发图 / read_image 工具结果 / 历史图片）进入文本模型时，
  // 图片块替换为视觉描述（缓存优先）；视觉不可用/失败时降级为占位文本。
  // 原图消息保留在会话日志——UI 显示原图；改写只发生在请求副本上。
  ctx.on('llm/stream', (
    options: GenerateOptionsLike,
    next: () => AsyncIterable<StreamChunkLike>,
  ): AsyncIterable<StreamChunkLike> => {
    if (!config.enabled || !isLoopBuilt(options) || !messagesHaveImage(options.messages)) return next()
    return (async function* () {
      let routeInfo
      try {
        routeInfo = await originalResolve(options.provider, options.model)
      } catch {
        routeInfo = undefined
      }
      // 原生视觉路由直通。
      if (routeInfo?.inputModalities?.includes('image')) {
        yield* next()
        return
      }
      let candidate: VisionCandidate | undefined
      try {
        candidate = await targets.pick()
      } catch {
        candidate = undefined
      }
      log.info(`stream: ${collectImages(options.messages as readonly UserMessageLike[]).length} image(s) in request, route ${options.provider}/${options.model}, candidate ${candidate === undefined ? 'NONE' : `${candidate.provider}/${candidate.model}`}`)
      try {
        const prepared = await llm.prepareCall(callConfigOf(options), options.signal)
        const occurrences = collectImages(options.messages as readonly UserMessageLike[])
        const plan = candidate === undefined
          ? { describedKeys: new Set<string>(), overflow: occurrences.map(occ => occ.ref.attachmentId) }
          : planVisionBudget(
            occurrences,
            occurrence => cache.get(cacheKeyOf(candidate, occurrence.ref.attachmentId)) !== undefined,
            config.batchMaxImages,
          )
        const { messages: rewritten } = await rewriteImageMessages(
          options.messages as readonly UserMessageLike[],
          async (occurrence) => {
            if (!plan.describedKeys.has(occurrenceKey(occurrence))) {
              return markerFor(occurrence.ref.attachmentId)
            }
            if (candidate === undefined) return markerFor(occurrence.ref.attachmentId)
            return replacementTextFor(candidate, occurrence, options.signal)
          },
        )
        for (const attachmentId of plan.overflow) {
          log.warn(`image ${attachmentId} beyond vision budget (batchMaxImages=${config.batchMaxImages}) in a request, replaced with placeholder`)
        }
        yield* prepared.stream({ ...options, messages: rewritten } as GenerateOptionsLike)
      } catch (error) {
        log.warn(`request rewrite failed, falling back to the original request: ${errorMessage(error)}`)
        yield* next()
      }
    })()
  })

  // ④ vision_ask 追问工具：主模型对图片指定方向/区域做二次识图。
  // 图片来源：会话内附件（attachmentId，从注入描述中获取）或本地图片路径（走 fs 沙箱）。
  if (config.visionAskEnabled && ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    const resolveRef = async (
      exec: { agent?: { session?: { events?: readonly unknown[] } }; signal?: AbortSignal },
      attachmentId: string | undefined,
      path: string | undefined,
    ): Promise<ImageAttachmentRef> => {
      if (typeof attachmentId === 'string' && attachmentId !== '') {
        const ref = findImageRefInEvents(exec.agent?.session?.events ?? [], attachmentId)
        if (ref !== undefined) return ref
        throw new Error(`vision_ask: attachment "${attachmentId}" is not referenced by this session`)
      }
      if (typeof path === 'string' && path.trim() !== '') {
        const fs = ctx.get<ContextLike['fs']>('fs')
        const attachments = ctx.get<ContextLike['attachments']>('attachments')
        if (fs === undefined || attachments === undefined) {
          throw new Error('vision_ask: fs/attachments services are not available in this deployment')
        }
        const mediaType = mediaTypeOfPath(path)
        if (mediaType === undefined) {
          throw new Error('vision_ask: unsupported image path (png/jpeg/webp/gif only)')
        }
        const target = await fs.resolve(path)
        const data = await fs.readBytes(target, exec.signal, 20 * 1024 * 1024)
        return attachments.saveImage({
          data,
          mediaType,
          ...nameOfPath(path) === undefined ? {} : { name: nameOfPath(path) },
        })
      }
      throw new Error('vision_ask: provide attachmentId or path')
    }
    ctx.tools.register({
      name: 'vision_ask',
      description: [
        'Look at an image with the auxiliary vision model and answer a specific question about it. ',
        'Use this when you need details beyond the injected description (e.g. text in a corner, a UI state, colors). ',
        'Provide `attachmentId` (from the "[用户附图 <id>…" description text) and/or `path` (local image file, png/jpeg/webp/gif).',
      ].join(''),
      parameters: visionAskParameters,
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      async execute(args: { attachmentId?: string; path?: string; question?: string }, exec: {
        agent?: { session?: { events?: readonly unknown[] } }
        signal?: AbortSignal
      }) {
        const question = typeof args.question === 'string' ? args.question.trim() : ''
        if (question === '') throw new Error('vision_ask: question must be a non-empty string')
        const ref = await resolveRef(exec, args.attachmentId, args.path)
        const candidate = await targets.pick()
        if (candidate === undefined) {
          throw new Error('vision_ask: no vision model available (configure visionChain or enable visionDiscovery)')
        }
        log.info(`vision_ask: ${candidate.provider}/${candidate.model} answering for ${ref.attachmentId}`)
        return describeWithQuestion(llm, candidate, ref, question, config.maxTokens, config.timeoutMs, exec.signal)
      },
    })
    log.info('vision_ask tool registered')
  }
}

/** 按扩展名推断图片媒体类型（png/jpeg/webp/gif）。 */
function mediaTypeOfPath(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}

/** 取路径尾段作为附件名。 */
function nameOfPath(path: string): string | undefined {
  const parts = path.split(/[\\/]/)
  const name = parts[parts.length - 1]
  return name === undefined || name === '' ? undefined : name
}
