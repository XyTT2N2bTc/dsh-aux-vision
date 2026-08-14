/**
 * dsh-aux-vision：DeepSeek Harness 辅助视觉插件。
 *
 * 三个钩子 + 一个能力申报补丁：
 * ① capability：resolveModelInfo 对未声明 image 的模型补报 image（放行准入守卫）；
 * ② agent/pre-step：含图轮次 → 视觉模型看原图（像素级）→ 描述文本原位替换 image 块；
 * ③ llm/stream：请求级兜底——工具结果/历史图片进入文本模型请求时替换为描述（缓存优先）。
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
  messagesHaveImage,
  occurrenceKey,
  planVisionBudget,
  rewriteImageMessages,
  type ImageOccurrence,
} from './rewrite.js'
import { describeImage, VisionTargets, type VisionCandidate } from './vision.js'
import type {
  GenerateOptionsLike,
  LlmServiceLike,
  StreamChunkLike,
  UserMessageLike,
} from './types.js'

export { Config }
export const name = 'dsh-aux-vision'
export const inject = ['llm'] as const

/** agent 的最小使用面（pre-step payload 里的 agent）。 */
interface AgentLike {
  options?: { provider?: string; model?: string }
  session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
}

/** cordis Context 的最小使用面。 */
interface ContextLike {
  llm: LlmServiceLike
  get<T = unknown>(key: string): T | undefined
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(fn: () => unknown, name?: string): void
  logger: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
}

/** agent/pre-step 决策的最小形状。 */
interface PreStepDecisionLike {
  kind: 'enter' | 'reject'
  messages?: readonly UserMessageLike[]
  [key: string]: unknown
}

/** 会话当前路由（最近一次请求头，退回 agent options）。 */
function currentRoute(agent: AgentLike): { provider: string; model: string } | undefined {
  const logged = agent.session?.requestHeader?.()?.config
  if (typeof logged?.provider === 'string' && typeof logged?.model === 'string' && logged.provider !== '' && logged.model !== '') {
    return { provider: logged.provider, model: logged.model }
  }
  const options = agent.options
  if (typeof options?.provider === 'string' && typeof options?.model === 'string' && options.provider !== '' && options.model !== '') {
    return { provider: options.provider, model: options.model }
  }
  return undefined
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

  // 视觉目标选择（配置链 + 自动发现），适配器/目录变更时刷新。
  const targets = new VisionTargets(originalResolve, llm, config.visionChain, config.visionDiscovery)
  ctx.on('llm/adapters-updated', () => targets.invalidate())

  // 描述缓存（attachmentId + 视觉模型维度）。
  const cache = createTtlCache(config.cacheMaxEntries, config.cacheTtlSeconds * 1000)

  /** 单图描述（带缓存）。 */
  const cacheKeyOf = (candidate: VisionCandidate, attachmentId: string): string =>
    `${candidate.provider}:${candidate.model}|${attachmentId}`
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

  /** 占位文本（历史兜底与降级共用）。 */
  const markerFor = (attachmentId: string): string => config.markerText.replace('{id}', attachmentId)

  /** 按策略产出替换文本：成功 → 描述模板；失败 → marker 或抛错。 */
  const replacementFor = async (
    candidate: VisionCandidate | undefined,
    occurrence: ImageOccurrence,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    if (candidate === undefined) {
      log.warn(`no vision model available for ${occurrence.ref.attachmentId}`)
      if (config.onVisionFailure === 'error') {
        throw new Error('aux-vision: no vision model available (configure visionChain or enable visionDiscovery)')
      }
      return markerFor(occurrence.ref.attachmentId)
    }
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

  // ② 主注入路径：agent/pre-step。
  ctx.on('agent/pre-step', async (
    payload: { agent: AgentLike; turn: number; step: number; signal?: AbortSignal },
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    if (!config.enabled) return next()
    const decision = await next()
    if (decision.kind === 'reject' || !Array.isArray(decision.messages) || !messagesHaveImage(decision.messages)) {
      return decision
    }
    const messages = decision.messages
    // 原生视觉路由（会话/子代理运行在声明 image 的模型上）不干预。
    const route = currentRoute(payload.agent)
    if (route === undefined) return decision
    let routeInfo
    try {
      routeInfo = await originalResolve(route.provider, route.model)
    } catch {
      routeInfo = undefined
    }
    if (routeInfo?.inputModalities?.includes('image')) {
      log.info(`pre-step: native vision route ${route.provider}/${route.model}, passthrough`)
      return decision
    }

    // 文本路由 + 含图 → 视觉目标选择。
    let candidate: VisionCandidate | undefined
    try {
      candidate = await targets.pick()
    } catch {
      candidate = undefined
    }
    log.info(`pre-step: ${collectImages(messages).length} image(s), route ${route.provider}/${route.model}, candidate ${candidate === undefined ? 'NONE' : `${candidate.provider}/${candidate.model}`}`)
    if (candidate === undefined) {
      log.warn('no vision model available; image admission still granted, using placeholders')
      if (config.onVisionFailure === 'error') {
        throw new Error('aux-vision: no vision model available (configure visionChain or enable visionDiscovery)')
      }
      const scrubbed = await rewriteImageMessages(messages, async (occurrence) =>
        markerFor(occurrence.ref.attachmentId))
      return { ...decision, messages: scrubbed.messages }
    }

    // 逐图描述：名额只给「缓存未命中」的图（命中/同图重复不占名额），超出占位。
    const occurrences = collectImages(messages)
    const plan = planVisionBudget(
      occurrences,
      occurrence => cache.get(cacheKeyOf(candidate, occurrence.ref.attachmentId)) !== undefined,
      config.batchMaxImages,
    )
    const { messages: rewritten } = await rewriteImageMessages(messages, async (occurrence) => {
      if (plan.describedKeys.has(occurrenceKey(occurrence))) {
        return replacementFor(candidate, occurrence, payload.signal)
      }
      log.warn(`image ${occurrence.ref.attachmentId} beyond vision budget (batchMaxImages=${config.batchMaxImages}), replaced with placeholder`)
      return markerFor(occurrence.ref.attachmentId)
    })
    for (const attachmentId of plan.overflow) {
      log.warn(`image ${attachmentId} beyond vision budget (batchMaxImages=${config.batchMaxImages}), replaced with placeholder`)
    }
    return { ...decision, messages: rewritten }
  })

  // ③ 请求级兜底：llm/stream。
  // LOOP 请求含图且路由为文本模型时，把图片块替换为视觉描述（缓存优先），
  // 视觉不可用/失败时降级为占位文本。覆盖两类不经过 pre-step 的图片：
  //  - 工具结果图片（read_image 等，tool/result 由 deriveMessages 直接折叠进请求）；
  //  - 插件启用前已入日志的历史图片。
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
            try {
              const description = await describeOne(candidate, occurrence, options.signal)
              return config.descriptionFormat
                .replace('{id}', occurrence.ref.attachmentId)
                .replace('{model}', candidate.model)
                .replace('{description}', description)
            } catch (error) {
              log.warn(`vision failed for attachment ${occurrence.ref.attachmentId}: ${errorMessage(error)}`)
              return markerFor(occurrence.ref.attachmentId)
            }
          },
        )
        for (const attachmentId of plan.overflow) {
          log.warn(`image ${attachmentId} beyond vision budget (batchMaxImages=${config.batchMaxImages}) in a request, replaced with placeholder`)
        }
        yield* prepared.stream({ ...options, messages: rewritten } as GenerateOptionsLike)
      } catch (error) {
        log.warn(`request scrub failed, falling back to the original request: ${errorMessage(error)}`)
        yield* next()
      }
    })()
  })
}
