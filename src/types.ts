/**
 * dsh-aux-vision 本地结构类型。
 *
 * 插件刻意不 import 任何 `@deepseek-ai/*` 运行时包：
 * 模块身份分裂会让跨包 WeakSet / instanceof 判定失效（如 isAgentLoopRequest），
 * 且 profile 装载器要求裸插件零依赖可解析。这里用最小结构类型描述
 * 实际用到的 llm / attachments / agent / cordis 表面，运行时全部结构调用。
 */

/** 持久化图片引用（与 dsh-attachment 的 ImageAttachmentRef 同形）。 */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** 消息内容块的最小形状（image 块携带 attachment 引用）。 */
export interface ContentBlockLike {
  type: string
  text?: string
  attachment?: ImageAttachmentRef
  content?: readonly ContentBlockLike[]
  [key: string]: unknown
}

/** 消息的最小形状。 */
export interface MessageLike {
  readonly id?: string
  readonly role?: string
  readonly content: readonly ContentBlockLike[]
  readonly source?: { readonly kind: string; readonly plugin?: string }
}

/** 用户消息。 */
export interface UserMessageLike extends MessageLike {
  readonly role: 'user'
}

/** llm.resolveModelInfo 返回的模态元数据。 */
export interface ResolvedModelInfoLike {
  provider: string
  id: string
  name: string
  inputModalities?: readonly string[]
}

/** llm 服务的最小使用面。 */
export interface LlmServiceLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfoLike>
  prepareCall(
    config: LlmCallConfigLike,
    signal?: AbortSignal,
  ): Promise<PreparedCallLike>
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<readonly ResolvedModelInfoLike[]>
}

/** 一次模型调用的配置字段（与 dsh-llm LlmCallConfig 同形）。 */
export interface LlmCallConfigLike {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** 一次流式调用的完整请求（与 dsh-llm GenerateOptions 同形）。 */
export interface GenerateOptionsLike extends LlmCallConfigLike {
  messages: readonly MessageLike[]
  system?: string
  tools?: readonly unknown[]
  signal?: AbortSignal
  sessionId?: string
}

/** prepareCall 的流式入口。 */
export interface PreparedCallLike {
  stream(options: GenerateOptionsLike): AsyncIterable<StreamChunkLike>
}

/** 流式 chunk（与 dsh-llm StreamChunk 同形，只取装配所需字段）。 */
export type StreamChunkLike =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlockLike }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: FinishReasonLike }
  | { type: 'error'; failure: { code: string; message: string } }
  | { type: 'aborted'; failure: { code: string; message: string } }

/** 流结束原因（只取需要区分的结果）。 */
export type FinishReasonLike =
  | { kind: 'stop' | 'length' | 'max-tokens' | 'content-filter' | 'tool-calls' }
  | { kind: 'error'; failure: { code: string; message: string } }
  | { kind: 'aborted'; failure: { code: string; message: string } }
