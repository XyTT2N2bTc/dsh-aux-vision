/**
 * 插件配置：手写 standard-schema 协议（`~standard.validate`），
 * 不依赖 @deepseek-ai/schemastery —— cordis loader 只要求 `Config['~standard'].validate`
 * （vendor/cordis/src/fiber.ts:50-62），返回 `{ value }` 或 `{ issues }`。
 */

/** 解析后的插件配置。 */
export interface AuxVisionConfig {
  /** 总开关。 */
  enabled: boolean
  /** ① 能力申报补丁：把未声明 image 的模型补报 image（放行准入守卫）。 */
  declareImageCapability: boolean
  /** 视觉候选链：按序尝试，跳过无适配器或不声明 image 的候选。 */
  visionChain: ReadonlyArray<{ readonly provider: string; readonly model: string }>
  /** 链全部不可用时，扫描所有已注册 provider 目录自动发现 image 模型兜底。 */
  visionDiscovery: boolean
  /** 单次视觉调用 maxTokens。 */
  maxTokens: number
  /** 单次视觉调用超时（毫秒）。 */
  timeoutMs: number
  /** 每轮最多调用视觉的图片数；超出部分用占位文本。 */
  batchMaxImages: number
  /** 视觉失败策略：marker = 占位文本继续；error = 该轮报错。 */
  onVisionFailure: 'marker' | 'error'
  /** 占位文本模板，`{id}` 替换为 attachmentId。 */
  markerText: string
  /** 注入描述的消息模板，`{id}` / `{model}` / `{description}` 可替换。 */
  descriptionFormat: string
  /** 视觉提示模板，`{user_text}` 替换为该消息的原文文本。 */
  visionPromptTemplate: string
  /** 描述缓存 TTL（秒）。 */
  cacheTtlSeconds: number
  /** 描述缓存上限条目。 */
  cacheMaxEntries: number
  /** 调试日志文件路径（空 = 关闭；设置后 warn/info 同时追加写入）。 */
  debugLogPath: string
}

export interface ConfigIssue {
  message: string
}

export interface ConfigResult {
  value?: AuxVisionConfig
  issues?: ConfigIssue[]
}

const DEFAULT_VISION_PROMPT_TEMPLATE = [
  '请查看这张图片（原图），用中文输出一份紧凑要点描述（正文 200 字以内；',
  '不要标题、不要表格、不要 markdown 格式）：',
  '- 主体内容：一句话概括',
  '- 可见文字：逐字摘录（若有）',
  '- 关键细节：布局、颜色、UI 元素与状态，以及任何与用户问题直接相关的信息',
  '- 不确定之处：明说',
  '',
  '用户消息原文：',
  '{user_text}',
].join('\n')

const DEFAULTS = {
  enabled: true,
  declareImageCapability: true,
  visionChain: [{ provider: 'opencode-go', model: 'mimo-v2.5' }],
  visionDiscovery: true,
  maxTokens: 8192,
  timeoutMs: 120000,
  batchMaxImages: 4,
  onVisionFailure: 'marker' as const,
  markerText: '[图片附件 {id}：辅助视觉模型暂不可用]',
  descriptionFormat: '[用户附图 {id}（{model}）：{description}]',
  visionPromptTemplate: DEFAULT_VISION_PROMPT_TEMPLATE,
  cacheTtlSeconds: 3600,
  cacheMaxEntries: 200,
  debugLogPath: '',
} satisfies Omit<AuxVisionConfig, 'visionChain'> & { visionChain: Array<{ provider: string; model: string }> }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function asBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

function asPositiveInt(raw: unknown, fallback: number, name: string, issues: ConfigIssue[]): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    issues.push({ message: `aux-vision: "${name}" must be a positive integer` })
    return fallback
  }
  return raw
}

function asString(raw: unknown, fallback: string, name: string, issues: ConfigIssue[]): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string') {
    issues.push({ message: `aux-vision: "${name}" must be a string` })
    return fallback
  }
  return raw
}

function parseVisionChain(raw: unknown): Array<{ provider: string; model: string }> {
  if (!Array.isArray(raw)) return [...DEFAULTS.visionChain]
  const chain: Array<{ provider: string; model: string }> = []
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (provider === '' || model === '') continue
    chain.push({ provider, model })
  }
  return chain.length > 0 ? chain : [...DEFAULTS.visionChain]
}

/** standard-schema 形状的配置 schema（cordis loader 直接消费）。 */
export const Config: {
  '~standard': {
    version: 1
    vendor: string
    validate(value: unknown): ConfigResult
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'dsh-aux-vision',
    validate(value: unknown): ConfigResult {
      if (value === undefined) return { value: { ...DEFAULTS } }
      if (!isPlainObject(value)) {
        return { issues: [{ message: 'aux-vision: config must be an object' }] }
      }
      const issues: ConfigIssue[] = []
      const onVisionFailure = value.onVisionFailure === 'error'
        ? 'error' as const
        : value.onVisionFailure === 'marker'
          ? 'marker' as const
          : value.onVisionFailure === undefined
            ? DEFAULTS.onVisionFailure
            : (issues.push({ message: 'aux-vision: "onVisionFailure" must be "marker" or "error"' }), DEFAULTS.onVisionFailure)
      const maxTokens = asPositiveInt(value.maxTokens, DEFAULTS.maxTokens, 'maxTokens', issues)
      const timeoutMs = asPositiveInt(value.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs', issues)
      const batchMaxImages = asPositiveInt(value.batchMaxImages, DEFAULTS.batchMaxImages, 'batchMaxImages', issues)
      const cacheTtlSeconds = asPositiveInt(value.cacheTtlSeconds, DEFAULTS.cacheTtlSeconds, 'cacheTtlSeconds', issues)
      const cacheMaxEntries = asPositiveInt(value.cacheMaxEntries, DEFAULTS.cacheMaxEntries, 'cacheMaxEntries', issues)
      if (issues.length > 0) return { issues }
      return {
        value: {
          enabled: asBoolean(value.enabled, DEFAULTS.enabled),
          declareImageCapability: asBoolean(value.declareImageCapability, DEFAULTS.declareImageCapability),
          visionChain: parseVisionChain(value.visionChain),
          visionDiscovery: asBoolean(value.visionDiscovery, DEFAULTS.visionDiscovery),
          maxTokens,
          timeoutMs,
          batchMaxImages,
          onVisionFailure,
          markerText: asString(value.markerText, DEFAULTS.markerText, 'markerText', issues),
          descriptionFormat: asString(value.descriptionFormat, DEFAULTS.descriptionFormat, 'descriptionFormat', issues),
          visionPromptTemplate: asString(value.visionPromptTemplate, DEFAULTS.visionPromptTemplate, 'visionPromptTemplate', issues),
          cacheTtlSeconds,
          cacheMaxEntries,
          debugLogPath: asString(value.debugLogPath, DEFAULTS.debugLogPath, 'debugLogPath', issues),
        },
      }
    },
  },
}

export type { Config as ConfigSchema }
