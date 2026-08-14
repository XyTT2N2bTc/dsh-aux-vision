# dsh-aux-vision

DeepSeek Harness 辅助视觉插件：**任意纯文本主模型 + 任意有识图能力的模型**（默认
`opencode-go/mimo-v2.5`）。含图轮次自动让视觉模型看**原图（像素级）**，并把描述以文本
注入当前轮供主模型使用；纯文本轮**零视觉调用**。主模型与路由保持完全不变。

## 核心优势

- **不换主模型**：为任意文本模型补齐图片准入，再由独立视觉模型完成识图。
- **自动且保真**：用户图片、历史图片和 `read_image` 结果都会按需转为像素级描述；会话 UI 仍保留原图。
- **成本可控**：纯文本轮零视觉调用；同图描述按视觉模型和附件缓存，重复图不消耗批次名额。
- **稳定降级**：视觉模型不可用、限流或超时时，可继续对话并注入可识别的占位文本。
- **可定向追问**：`vision_ask` 能让主模型针对指定附件或本地图片再次提问，无须更换当前会话模型。

零运行时依赖（不 import 任何 `@deepseek-ai` 包，全部结构调用 `ctx.llm` / `ctx.attachments`），
完整复用 DSH 的 llm 服务管线（`resolveModelInfo` / `prepareCall` / 流式协议），不重复实现
provider 适配。

## 工作原理

```
发图(prompt RPC) ── 准入守卫 ──┬─ 通过（① 能力申报：未声明 image 的模型补报 image）
                               └─ 拒绝（未安装插件时的现状）
        ↓ followup → inbox → 原图消息落日志（**UI 显示原图**）
        ↓ 请求构建（历史含图消息一并进入请求）
② llm/stream：请求含图 & 路由未声明 image
   ├─ 有图：视觉模型看原图 → 描述文本原位替换 image 块（改写请求副本）→ 主模型作答
   └─ 无图：直通（零视觉调用、零开销）
```

| 环节 | 说明 |
| --- | --- |
| ① 能力申报 | 补丁 `llm.resolveModelInfo`：凡原方法未声明 `image` 的模型，在返回副本中补入 `image`。prompt 准入守卫 / selectModel 守卫 / read_image 模态闸门因此对任意文本模型放行。pi-ai 适配器线路级检查读 pi-ai 目录，不受影响（最后一道安全网）。卸载/禁用即还原。 |
| ② 注入 | `llm/stream`：LOOP 请求含图（用户发图 / read_image 工具结果 / 历史图片）且路由未声明 image 时，把图片块替换为视觉描述（缓存优先）或占位，改写请求副本放行。**原图消息保留在会话日志——UI 显示原图，描述只出现在模型请求里**。 |
| 视觉目标 | 配置候选链 `visionChain` 按序尝试（跳过无适配器/不声明 image 的候选）；链全不可用时 `visionDiscovery` 扫描**所有已注册 provider** 的目录取第一个 image 模型兜底；全不可用 → 按 `onVisionFailure` 降级。 |
| 缓存 | 描述按 `provider:model|attachmentId` 缓存（TTL 可配），同图同轮/后续步骤/跨会话零重复调用。 |
| 纯文本轮 | llm/stream 无图直通——**不产生任何视觉调用**（历史图片改写走缓存，零模型开销）。 |
| 原生视觉路由 | 会话/子代理运行在声明 image 的模型上时不重写、不注入，原生看图。 |

## 安装

### 方式一：dsh plugin（需要发布到 GitHub/npm 后）

```sh
dsh plugin --profile web add github:<owner>/dsh-aux-vision
```

### 方式二：手动（本仓库开发期）

1. 构建：`npm install && npm run build`（产物在 `lib/`）。
2. 复制到 profile 可解析位置：

   ```sh
   # 把 lib/、cordis.patch.yml、package.json 放入：
   # $DSH_HOME/profiles/web/node_modules/dsh-aux-vision/
   ```

3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: aux-vision
         name: dsh-aux-vision
   ```

4. 保存后**重启 DSH**（HMR 不重载 profile node_modules 里的插件文件；config 热更新会重新
   apply，但 lib 更新必须重启）。

卸载：移除 patch 条目（配置热更新即可卸载）；如需同时移除包，删除 node_modules 目录。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: aux-vision
      name: dsh-aux-vision
      config:
        enabled: true                  # 总开关
        declareImageCapability: true   # ① 能力申报补丁
        visionChain:                   # 视觉候选链（任意已注册 provider）
          - provider: opencode-go
            model: mimo-v2.5
        visionDiscovery: true          # 链不可用时自动扫描全部 provider 目录兜底
        maxTokens: 8192                # 视觉调用上限
        timeoutMs: 120000              # 视觉调用超时
        batchMaxImages: 4              # 每轮/每请求最多【调用视觉】的图片数；
                                       # 缓存命中/重复图不占名额（直接取缓存），
                                       # 名额优先给新图；超出部分占位
        onVisionFailure: marker        # marker | error（见降级）
        markerText: '[图片附件 {id}：辅助视觉模型暂不可用]'   # {id}=attachmentId
        descriptionFormat: '[用户附图 {id}（{model}）：{description}]'
        descriptionDetail: standard    # compact | standard(默认) | detailed 三档详细度
        visionPromptTemplate: '…'      # 显式配置时覆盖 descriptionDetail 档位
        cacheTtlSeconds: 3600          # 描述缓存 TTL
        cacheMaxEntries: 200
        debugLogPath: ''               # 调试日志文件（空=关；warn/info 同时追加写入）
        injectGuidance: true           # 向系统提示注入「辅助视觉引导」
        guidanceText: '…'              # 引导文本（{model} 替换为视觉模型名）
        guidanceOrder: 500             # 引导段落排序（不与内置段落冲突即可）
        visionAskEnabled: true         # 注册 vision_ask 追问工具（二次定向识图）
```

## 降级行为

| 场景 | 行为 |
| --- | --- |
| 视觉候选全部不可用 / 调用失败（网络/限流/超时/空输出） | `onVisionFailure: marker`（默认）→ 占位文本，轮次继续；`error` → 该轮报错 |
| 附件读取失败 | 同上游（marker / error） |
| 主模型请求失败 | 不干预：走既有 llm-retry / agent/request-error |
| 纯文本轮 | 零视觉调用、零重写 |
| 原生视觉路由（会话/子代理） | 不重写、不注入 |
| 插件禁用/卸载 | 能力申报还原；守卫恢复原样；历史纯文本日志继续可用 |

## 开发检查

```sh
npm run typecheck
npm test
npm run build
```

## 已知边界

- **UI 显示**：原图消息保留在会话日志，会话记录显示**原图**；描述只出现在模型请求里
  （v0.2）。历史含图消息在每次请求构建时走缓存改写（毫秒级，零视觉调用）。
- **切换边界**：会话切到原生视觉模型后发图 → 原生看图（路由声明 image 直通）。
- **能力申报副作用**：文本模型在 models 目录显示为支持图片（与「装了插件后的复合能力」一致）。
- **mimo 偶发描述不准确**：属视觉模型自身质量波动；可在 `visionChain` 配置更强模型或
  多候选降级。

## License

MIT
