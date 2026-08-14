# dsh-aux-vision

DeepSeek Harness 辅助视觉插件：**任意纯文本主模型 + 任意有识图能力的模型**（默认
`opencode-go/mimo-v2.5`）。含图轮次自动让视觉模型看**原图（像素级）**，并把描述以文本
注入当前轮供主模型使用；纯文本轮**零视觉调用**。主模型与路由保持完全不变。

零运行时依赖（不 import 任何 `@deepseek-ai` 包，全部结构调用 `ctx.llm` / `ctx.attachments`），
完整复用 DSH 的 llm 服务管线（`resolveModelInfo` / `prepareCall` / 流式协议），不重复实现
provider 适配。

## 工作原理

```
发图(prompt RPC) ── 准入守卫 ──┬─ 通过（① 能力申报：未声明 image 的模型补报 image）
                               └─ 拒绝（未安装插件时的现状）
        ↓ followup → inbox
② agent/pre-step：本轮含图 & 会话路由未声明 image
   ├─ 有图：视觉模型看原图 → 描述文本原位替换 image 块 → 落日志（纯文本）→ 主模型作答
   └─ 无图：原样返回（零视觉调用、零开销）
        ↓
③ llm/stream（请求级兜底）：工具结果图片（read_image 等）与历史图片
   进入文本模型请求时 → 视觉描述（缓存优先），失败 → 占位文本
```

| 环节 | 说明 |
| --- | --- |
| ① 能力申报 | 补丁 `llm.resolveModelInfo`：凡原方法未声明 `image` 的模型，在返回副本中补入 `image`。prompt 准入守卫 / selectModel 守卫 / read_image 模态闸门因此对任意文本模型放行。pi-ai 适配器线路级检查读 pi-ai 目录，不受影响（最后一道安全网）。卸载/禁用即还原。 |
| ② 主注入 | `agent/pre-step` waterfall：检测本轮消息含图且会话路由（`requestHeader` 或 `agent.options`）未声明 image → 视觉模型看原图 → 描述原位替换 image 块 → 消息落日志（纯文本，重放/压缩/切模型全安全）。 |
| ③ 请求兜底 | `llm/stream`：LOOP 请求含图且路由为文本模型时，把图片块替换为描述（缓存优先）或占位。覆盖不经过 pre-step 的图片：工具结果图（`tool/result` 由 `deriveMessages` 直接折叠进请求）、插件启用前的历史图片。 |
| 视觉目标 | 配置候选链 `visionChain` 按序尝试（跳过无适配器/不声明 image 的候选）；链全不可用时 `visionDiscovery` 扫描**所有已注册 provider** 的目录取第一个 image 模型兜底；全不可用 → 按 `onVisionFailure` 降级。 |
| 缓存 | 描述按 `provider:model|attachmentId` 缓存（TTL 可配），同图同轮/后续步骤/跨会话零重复调用。 |
| 纯文本轮 | pre-step 无图短路；llm/stream 无图直通——**不产生任何视觉调用**。 |
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
        visionPromptTemplate: '…'      # 含 {user_text} 占位
        cacheTtlSeconds: 3600          # 描述缓存 TTL
        cacheMaxEntries: 200
        debugLogPath: ''               # 调试日志文件（空=关；warn/info 同时追加写入）
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

## 验证

```sh
node scripts/make-test-image.mjs   # 生成确定性测试图 test-fixtures/colors.png
node scripts/verify.mjs            # 端到端验证（发图/纯文本/read_image 三条路径）
node scripts/verify-budget.mjs     # 名额分配验证（历史缓存图不占 batchMaxImages 名额）
```

验证要点（均已在本地 0.1.0-rc.5 + opencode-go 实测通过）：

1. 新会话（默认 dsv4-flash）发图 → 准入放行，用户消息出现 `[用户附图 …（mimo-v2.5）：…` 描述注入，回复体现图片信息；
2. 纯文本轮 → 回复正常且不含注入/占位文本；debug 日志无任何 `describe`/`stream` 条目；
3. `read_image` 路径 → 工具结果图片经请求级兜底获得视觉描述（缓存命中），回复体现图片信息；
4. 原生视觉路由（切 mimo-v2.5）→ 不重写、不注入；
5. 降级路径：`visionChain` 配无效模型 + `visionDiscovery: false` → 占位文本，轮次继续；
6. config 热更新（改 patch 配置）→ 插件重新 apply，能力补丁链幂等；
7. 名额分配：会话历史已有 4 张缓存图时，新 `read_image` 的图仍获得描述
   （缓存命中/重复图不占 `batchMaxImages` 名额，名额优先给新图）。

## 已知边界

- **UI 显示**：新发图经描述注入后，会话记录里用户消息显示为描述文本（原图在附件库，
  文本含 attachmentId 可追溯）；日志保持纯文本是重放/压缩/切模型安全的前提。
- **切换边界**：会话切到原生视觉模型后、尚无 request header 时的第一张图仍会走注入
  （视觉模型收到描述文本而非原图）；下一步起恢复原生。
- **能力申报副作用**：文本模型在 models 目录显示为支持图片（与「装了插件后的复合能力」一致）。
- **孤儿附件**：被替换的图片字节留在附件库（内容寻址），无引用；量级有界。
- **mimo 偶发描述不准确**：属视觉模型自身质量波动；可在 `visionChain` 配置更强模型或
  多候选降级。

## License

MIT
