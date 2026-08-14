# dsh-aux-vision 设计方案（v0.2 草案，泛化版，待用户确认）

> 目标：主模型保持任意**纯文本模型**不变（不限 provider/model，只要 llm 目录未声明 image 能力）；
> 含图轮次自动分流给**任意有识图能力的模型**（默认 opencode-go/mimo-v2.5，可配候选链 + 自动发现）
> 看原图（像素级），结果以文本注入当前轮供主模型使用；纯文本轮完全不触发视觉调用。

## 0. 前置事实（已核实，2026-08 本地 checkout 0.1.0-rc.5）

| 事实 | 出处 |
| --- | --- |
| pi-ai 内置目录：`deepseek-v4-flash/pro` 声明 `input:["text"]`；`mimo-v2.5` 声明 `input:["text","image"]`（openai-completions，baseUrl `https://opencode.ai/zen/go/v1`） | `~/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json` |
| prompt RPC 图片准入守卫：会话当前模型 `inputModalities` 不含 `image` → 拒绝 `MODEL_DOES_NOT_SUPPORT_IMAGES` | `packages/host/apiproxy/src/api-proxy.ts:2482-2495` |
| selectModel 守卫：含图会话切文本模型被拒 | 同上 `:2295-2306` |
| read_image 工具闸门：按路由 `resolveModelInfo` 显式要求 image 模态，unknown 也拒绝 | `packages/fs/tool-fs/src/read-image.ts:64-76` |
| pi-ai 适配器线路级检查：请求含图但 pi-ai 目录不声明 image → 抛 `UNSUPPORTED_CONTENT`（**最后一道安全网，不受插件影响**） | `packages/llm/llm-pi-ai/src/adapter.ts:303-308` |
| `agent/pre-step` waterfall：返回的 `decision.messages` 会以 `user/message` 落 session 日志，请求由日志派生；重写消息是官方支持的用法 | `packages/core/agent-loop/src/agent.ts:234-243, 282-284`；`packages/core/agent/src/runtime-types.ts:220-231` |
| agent-loop invariant：LOOP 请求必须冻结且 `messages` 必须等于日志派生结果（`llm/stream` 层不可改请求）；pre-step 重写与 invariant 天然一致 | `packages/core/agent-loop/src/invariant.ts:39-42` |
| `markAgentLoopRequest` 用 WeakSet，spread 新对象自动失标记 | `packages/llm/llm/src/call-config.ts:13,66-77` |
| llm-retry 走 `agent/request-error`（循环层），不监听 `llm/stream` → 短路 `llm/stream` 不破坏重试 | `packages/llm/llm-retry/src/index.ts` |
| 附件服务：`ctx.attachments.readImage(ref, signal?) → {ref,data}`、`imageLimits` | `packages/attachment/attachment/src/index.ts:35-59` |
| llm 服务事件 `llm/adapters-updated`（适配器/目录变更时 emit）→ 可用于刷新视觉模型自动发现 | `packages/llm/llm/src/index.ts:296-322` |
| RPC 层 `connection.rpc.intercept` 每 channel 唯一，已被 api-gateway 占用 `/api` → 插件无法拦截 RPC | `packages/client/connection/src/rpc-host.ts:127-140` |
| cordis `ctx.intercept(name, config)` 只做服务配置拦截，非方法包装 | `vendor/cordis/src/context.ts:128-144` |
| bundle 包形态：package.json `dsh.bundle.patch` 指向 `cordis.patch.yml`，exports 暴露该文件 | `packages/bundle/base/package.json:36-40` |
| 现存插件：`Isekai-Mfu/dsh-mimo-vision-hint`（同款 provider/model，只注入 system prompt 提示）、`libinyam/dsh-vision-provider`（配置型加视觉路由）、`william-jin-cmu/dsh-vision`（view_image 工具）、`ysr666/dsh-vision-router`（整轮路由，用户已否决） | GitHub 检索 2026-08 |

## 1. 总体架构（泛化版）

三个钩子 + 一个能力申报补丁，全部为 cordis 插件（宿主层，profile web 装配）。
**不再限定具体模型**：一切判定基于 llm 目录的模态声明（`inputModalities` 是否含 `image`），
源（被辅助的文本模型）与目标（视觉模型）都是动态解析的。

```
发图(prompt RPC) ── 准入守卫 ──┬─ 通过（补丁①：凡未声明 image 的模型，补报 image 能力）
                               └─ 拒绝（无插件时现状）
        ↓ followup → inbox
 agent/pre-step ②：本轮含图 & 会话路由未声明 image（原方法判定）
        ├─ 有图：候选视觉模型链（配置优先 + 自动发现兜底）看原图 → 描述文本原位替换 image 块
        │        → 消息落日志（纯文本）→ 请求派生 → 主模型作答（含描述上下文）
        └─ 无图：原样返回（零视觉调用、零开销）
        ↓ 历史图片兜底
 llm/stream ③：LOOP 请求含图 & 路由未声明 image → 副本短路（image→marker）
        （覆盖：插件启用前已含图的会话切回文本模型的场景）
```

## 2. 钩子与服务依赖

### ① resolveModelInfo 能力申报补丁（准入旁路，泛化）

- **做法**：apply 时取得 `ctx.llm` 实例并保存**原方法引用** `originalResolveModelInfo`；
  把实例方法替换为包装版：
  **对任意 provider/model**，当原方法返回的 `inputModalities` 缺失或不含 `'image'` 时，
  在副本中补入 `'image'`；已声明 image 的模型原样返回。
  `ctx.effect` 注册 dispose：卸载时还原原方法（幂等，可重复挂载）。
  配置开关 `declareImageCapability`（默认 true）可关闭补丁。
- **效果**：prompt 准入守卫、selectModel 守卫、read_image 模态闸门对**所有纯文本模型**放行——
  与「插件可为任意文本模型提供辅助视觉」的复合能力一致。
- **内部判定不混淆**：插件自身判定「会话路由是否文本模型」一律用**原方法**
  （`originalResolveModelInfo`），与对外申报互不影响。
- **安全网仍在**：pi-ai 适配器线路级检查读 pi-ai 目录（`model.input`），不被补丁影响——
  漏网的图片进请求仍会被适配器拒绝，绝不把图发给文本模型；
  且本插件在 pre-step/llm/stream 两层都保证图片不进请求。
- **副作用（文档化）**：models RPC 目录（UI 模型选择器）会把所有文本模型显示为支持图片；
  卸载插件后自动还原。

### ② agent/pre-step（主注入路径，泛化）

- 监听 `agent/pre-step`（宿主 ctx 注册，接收全部 agent 事件，含子代理）。
- 流程：
  1. `const decision = await next()`；`reject` 直接透传。
  2. **文本路由判定**（泛化）：`const route = agent.session.requestHeader()?.config ?? agent.options`；
     用 `originalResolveModelInfo(route.provider, route.model)` 判定：
     `inputModalities` 缺失或不含 `'image'` → 视为纯文本路由 → 本插件辅助；
     含 `'image'`（原生视觉模型/子代理）→ 原样返回，不干预。
  3. 图片检测：`decision.messages` 内递归找 `type:'image'` 块（与 `contentHasImage` 同语义）。
     无图 → 原样返回（零视觉调用、零开销）。
  4. **视觉模型选择**（泛化，见 §3）：
     - 候选链 `visionChain`（配置，默认 `[{provider:'opencode-go', model:'mimo-v2.5'}]`）按序尝试：
       跳过无适配器（`llm` 未注册该 provider）或不声明 image（原方法判定）的候选；
     - 链全部不可用且 `visionDiscovery: true` → 扫描**所有已注册 provider** 的目录
       （`ctx.llm.listProviders()` + `ctx.llm.listModels(provider)`，结果缓存，
       监听 `llm/adapters-updated` 刷新），取第一个声明 image 的模型兜底；
     - 一个都不可用 → 按降级策略（marker/error）处理本轮。
  5. 视觉调用（批处理，`batchMaxImages` 默认 4）：
     - 每个 attachment：`ctx.attachments.readImage(ref, signal)` 取**原图像素**；
     - 组装视觉请求（手建 GenerateOptions，不带 LOOP 标记）：
       `{ provider: 选中候选.provider, model: 选中候选.model, maxTokens, signal,
          messages: [{ role:'user', content: [ {type:'image',attachment:ref},
                     {type:'text', text: 提示模板 + 该消息的原文文本 } ],
                      source:{kind:'plugin',plugin:'dsh-aux-vision'} }] }`；
       携带用户消息原文，让视觉模型回答贴合用户意图；
     - 经 `ctx.llm.prepareCall(config)` + `prepared.stream(options)` 流式调用
       （**复用 llm 服务：resolveCallConfig/resolveModelInfo/流式协议全走 DSH 现成管线**，
       不重复实现 provider 适配）；
     - `BlockAssembler` 组装文本；`finish.kind` 非正常 → 换下一候选重试；
     - 结果按 `attachmentId + 视觉模型 id` 缓存（TTL 可配），同图同轮/后续步骤不重复调用。
  6. 注入：每个 image 块原位替换为 text 块
     `[用户附图 <attachmentId>：<视觉模型描述>]`（前缀可配，附模型名更透明），其余块不动；
     返回 `{...decision, messages: 重写后消息}`。
  7. 重写后的消息落日志 → 请求由日志派生 → **invariant 一致性天然成立**；
     日志保持纯文本 → 重放/压缩/恢复/切模型全部安全。
- 纯文本轮：步骤 3 短路返回，**零 llm 调用、零重写**。

### ③ llm/stream（请求级兜底，描述优先）

- 监听 `llm/stream`：仅当 `isLoopBuilt(options)`（带 `sessionId` 且深冻结的近似判定，
  避免跨模块 WeakSet）且路由经**原方法**判定未声明 image 且 `options.messages` 含 image 块时触发
  （其余直通 `next()`，含视觉模型原生请求）。
- 做法：`ctx.llm.prepareCall` + `rewriteImageMessages` 把图片块替换为**视觉描述**
  （缓存优先，失败降级占位文本），构造重写副本
  `{ ...options, messages: 重写后 }`（spread 后自然失去 LOOP 标记 → 副本不被 invariant 检查、
  不再次触发本监听），`prepared.stream(副本)` 短路返回。
- 覆盖两类**不经过 pre-step** 的图片：
  - 工具结果图片（`read_image` 等：`tool/result` 事件由 `deriveMessages` 直接折叠进请求）；
  - 插件启用前已入日志的历史图片（同样优先描述，失败 marker；缓存保证每图最多一次视觉调用）。
- 重试语义：llm-retry 在循环层（agent/request-error）工作，短路不影响。
- 愿景调用（mimo）路由不在文本范围 → 直通，不受影响。

### 服务依赖

| 服务 | 用途 | 注入方式 |
| --- | --- | --- |
| `llm` | resolveModelInfo 补丁（+原方法引用）、prepareCall/stream 视觉调用、llm/stream 监听、listProviders/listModels 自动发现 | `ctx.inject(['llm'], ...)` + `ctx.get('llm')` |
| `attachments` | readImage 取原图像素 | `ctx.inject(['attachments'], ...)`（缺省时降级为 marker 并告警） |
| （无）agents/sessions | 经事件 payload 取 agent/session | — |

## 3. 视觉目标选择（泛化核心）

**原则**：目标 = 「任意已注册 provider 中声明 image 能力的模型」，优先级：

1. **配置候选链** `visionChain`：`[{provider, model}, ...]`，按序尝试；
   候选须满足：该 provider 有适配器（`ctx.llm.listProviders()` 可查）且该模型经**原方法**
   `resolveModelInfo` 声明 image。
2. **自动发现**（`visionDiscovery: true`，默认开启）：链全部不可用时，扫描所有已注册
   provider 的 `listModels()`，取第一个声明 image 的模型兜底；
   发现结果缓存，监听 `llm/adapters-updated` 自动刷新。
3. **全部不可用** → 本轮按 `onVisionFailure` 降级（marker/error），并日志告警。

默认配置（开箱即用，用户环境）：

```yaml
visionChain:
  - provider: opencode-go
    model: mimo-v2.5
visionDiscovery: true
```

## 4. 配置（Config schema，cordis.patch.yml 内配置）

```yaml
- insert:
    - id: aux-vision
      name: dsh-aux-vision
      config:
        enabled: true                 # 总开关
        declareImageCapability: true  # ① 能力申报补丁（放行准入守卫）
        visionChain:                  # ③ 视觉候选链（任意已注册 provider/model）
          - provider: opencode-go
            model: mimo-v2.5
        visionDiscovery: true         # 链不可用时自动扫描全部 provider 目录兜底
        maxTokens: 8192               # 视觉调用上限
        timeoutMs: 120000             # 视觉调用超时
        batchMaxImages: 4             # 每轮/每请求最多【调用视觉】的图片数；
                                      # 缓存命中/重复图不占名额（直接取缓存），名额优先给新图，超出占位
        onVisionFailure: marker       # marker | error（见降级）
        markerText: '[图片附件 {id}：辅助视觉模型暂不可用]'
        descriptionFormat: '[用户附图 {id}（{model}）：{description}]'
        visionPromptTemplate: '…'     # 默认含用户消息原文的提示模板
        cacheTtlSeconds: 3600
        cacheMaxEntries: 200
        debugLogPath: ''              # 调试日志文件（空=关）
```

## 5. 降级行为

| 场景 | 行为 |
| --- | --- |
| 候选链 + 自动发现全部不可用 / mimo 等调用失败（网络/限流/超时） | `onVisionFailure: marker`（默认）→ 占位文本，轮次继续；`error` → 该轮以错误结束（用户可见） |
| 附件读取失败 / 视觉输出为空 | 同上游：marker 或 error（空输出先换下一候选） |
| 主模型请求失败 | 不干预：走既有 llm-retry / agent/request-error 链路 |
| 纯文本轮 | 无视觉调用、无重写、零开销（验证重点） |
| 会话/子代理运行在原生视觉模型上 | 不重写、不注入，原生看图 |
| 插件禁用或卸载 | 还原 resolveModelInfo；守卫恢复原样；已有纯文本日志继续可用 |
| 无 attachments 服务 | 视觉调用不可用 → marker 降级 + 日志告警 |

## 6. 已知边界与风险（文档化）

1. **UI 显示**：新发图经重写后，会话记录里用户消息显示为「描述文本」（原图在附件库，
   文本保留 attachmentId 与视觉模型名可追溯）。日志纯文本是重放/压缩/切模型安全的前提。
2. **切换边界**：会话从文本模型切到原生视觉模型后、尚无 request header 时发的第一张图
   仍会被重写（视觉模型收到描述文本而非原图）；第一步之后 header 记录原生路由 → 不再重写。
3. **能力申报副作用**：所有文本模型在 models 目录显示 image 能力（与复合能力一致）。
4. **延迟**：视觉调用在 pre-step 内同步等待，图片轮首步增加一次视觉往返（超时可配）。
5. **孤儿附件**：被重写的图片字节仍在附件库（内容寻址），无引用；量级有界，后续可加清理。
6. **核心补丁面**：只补丁 `LlmRuntime` 实例的 `resolveModelInfo`（rc.5 签名），卸载即还原；
   DSH 升级后需回归验证。
7. **未知模态模型**：`inputModalities` 缺失视为纯文本（辅助），与 read_image 闸门
   「unknown 即拒绝」的保守语义一致；若某模型实际原生支持图片但未声明，会降级为描述注入
   （可用 `declareImageCapability`/判定逻辑的文档说明规避）。

## 7. 备选方案对比（为何不选）

| 方案 | 结论 |
| --- | --- |
| 整轮路由到视觉模型（dsh-vision-router 思路） | 主模型被替换、每图轮全量视觉计费 |
| system prompt 提示（dsh-mimo-vision-hint 思路） | 模型自行决定是否派子代理，无保证；read_image 闸门仍拦 |
| 纯工具（view_image/vision_describe） | 需模型自主调用，不满足「自动分流」 |
| 只在 llm/stream 重写 | 违反 agent-loop invariant（请求必须等于日志派生），且每步重触发；仅作历史兜底保留 |
| 修改核心 api-proxy.ts 守卫 | 插件不自包含、升级丢失；用能力申报补丁替代 |

## 8. 交付与验证

- **交付物**（C:\dsh-aux-vision）：`package.json`（含 `dsh.bundle`）、`src/*.ts`、
  `lib/`（构建产物）、`cordis.patch.yml`（bundle 层，insert 行）、`README.md`、
  `docs/DESIGN.md`、纯函数单测（node:test）。
- **装配**：加入 profile web：package.json dependencies 记录 `dsh-aux-vision` +
  `profiles/web/cordis.patch.yml` insert（或后续 `dsh plugin --profile web add github:…`）。
- **本机验证清单**（用户要求）：
  1. 新会话（默认 dsv4-flash）：发图+提问 → 回复体现图片信息；插件日志恰一次视觉调用；
  2. 纯文本轮 → 日志无视觉调用；
  3. read_image 路径：模型对本地文件调 read_image → 回复体现图片信息；
  4. 原生视觉会话（切 mimo-v2.5）发图 → 原生看图、无重写日志；
  5. 泛化验证：把主模型换成目录内其他文本模型（如 opencode-go/glm-5.1）→ 同样注入生效；
  6. 降级路径：visionChain 配无效模型 + discovery 关闭 → marker 占位、轮次继续；
  7. 历史兜底：曾在 mimo 发图的会话切回文本模型 → 轮次正常（marker）。
