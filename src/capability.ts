/**
 * ① resolveModelInfo 能力申报补丁。
 *
 * 把 llm 实例的 resolveModelInfo 包装一层：凡原方法未声明 image 能力的模型，
 * 在返回副本中补入 'image'。效果是 prompt 准入守卫 / selectModel 守卫 /
 * read_image 模态闸门（三者都读 resolveModelInfo）对任意文本模型放行——
 * 与「插件可为任意文本模型提供辅助视觉」的复合能力一致。
 *
 * pi-ai 适配器线路级检查读的是 pi-ai 目录（model.input），不受本补丁影响：
 * 漏网的图片进请求仍会被适配器拒绝，这是最后一道安全网。
 *
 * 幂等性（插件热重载 / config reload 会重新 apply，fiber update 的
 * dispose 与 apply 顺序不保证）：
 * - 安装时若 llm.resolveModelInfo 已带本插件的标记（上次安装的补丁残留），
 *   不再叠加包装，original 仍取原型方法；
 * - dispose 仅在当前方法确为本实例安装的补丁时还原；
 * - 内部判定（original）永远指向原型方法，不受任何补丁影响。
 */

import type { LlmServiceLike, ResolvedModelInfoLike } from './types.js'

export type ResolveModelInfo = LlmServiceLike['resolveModelInfo']

/** 标记本插件安装的补丁包装。 */
const PATCH_MARK = Symbol('dsh-aux-vision.resolveModelInfo')

type PatchedResolve = ResolveModelInfo & { [PATCH_MARK]?: true }

/** 原型方法（永不被补丁）。 */
function prototypeResolve(llm: LlmServiceLike): ResolveModelInfo {
  const proto = Object.getPrototypeOf(llm) as { resolveModelInfo?: unknown } | null
  if (proto !== null && typeof proto.resolveModelInfo === 'function') {
    return proto.resolveModelInfo as ResolveModelInfo
  }
  return llm.resolveModelInfo
}

/**
 * 安装能力申报补丁。
 * @param llm - llm 服务实例（补丁其实例方法，prototype 不动）。
 * @param enabled - 是否启用（false 时返回 no-op）。
 * @returns 还原函数与「补丁前」的原始方法（绑定由调用方负责）。
 */
export function installCapabilityDeclaration(
  llm: LlmServiceLike,
  enabled: boolean,
): { dispose(): void; original: ResolveModelInfo } {
  const current = llm.resolveModelInfo as PatchedResolve
  // 已装有本插件补丁（残留链）：不再叠加，original 仍取原型方法。
  if (current?.[PATCH_MARK] === true) {
    return { dispose: () => {}, original: prototypeResolve(llm) }
  }
  const original: ResolveModelInfo = prototypeResolve(llm)
  if (!enabled || typeof original !== 'function') {
    return { dispose: () => {}, original }
  }
  const patched: PatchedResolve = async function (this: unknown, provider, model, signal) {
    const info: ResolvedModelInfoLike = await original.call(this, provider, model, signal)
    const modalities = info.inputModalities
    if (modalities !== undefined && modalities.includes('image')) return info
    return { ...info, inputModalities: [...(modalities ?? []), 'image'] }
  }
  patched[PATCH_MARK] = true
  llm.resolveModelInfo = patched
  return {
    dispose: () => {
      if (llm.resolveModelInfo === patched) {
        llm.resolveModelInfo = original
      }
    },
    original,
  }
}
