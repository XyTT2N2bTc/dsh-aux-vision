# dsh 视觉类插件横向对比（2026-08-14 调研）

> 调研方法：GitHub 搜索（topic:dsh 690 仓库 + 关键词交叉 75 去重）→ 视觉类 50+ →
> 拉取 8 个代表性仓库源码核验机制（API 使用模式 + 入口注释 + 依赖清单）。

## 方案分型

| 分型 | 代表 | 机制 | 特点 |
| --- | --- | --- | --- |
| **工具桥** | `liustack/modlens` ⭐1022、`Anionex/dsh-vision-toolkit` ⭐275、`william-jin-cmu/dsh-vision`、`ysr666/dsh-vision-router`（vision_describe） | 注册工具（read_image/view_image/vision_describe），模型自主调用 | 触发靠模型决策；UI 无副作用；无「自动」保证 |
| **组合适配器路由** | `Flyvhidbwo/dsh-vision-proxy`、`121103qwq/dsh-vision-sidecar`（本机已装） | 注册组合路由（如 deepseek-vision）：resolveModel 声明 image + stream 内转译图片后委托主模型 | 会话模型被换为组合路由；转译发生在适配器层 |
| **llm/stream 自动注入** | `237229953-create/dsh-vision`、`lakeofsky347/dsh-vision` | 拦截 llm/stream：请求含图且目标未声明 image → 视觉模型转文字 → 改写 messages + **surface-replace 落日志** | 首轮改写 + 落库；后续请求天然文本化；UI 保留原图（foldSurface 只作用于模型投影） |
| **pre-step 自动注入** | **dsh-aux-vision（本插件）** | 拦截 agent/pre-step：含图轮 → 视觉描述原位替换 → 落日志（纯文本） | 首轮零改写、invariant 天然一致；UI 显示描述文本（已知局限） |
| **系统提示** | `Isekai-Mfu/dsh-mimo-vision-hint` | 提示模型派视觉子代理 | 无保证；read_image 闸门仍拦 |

## 关键机制对比（与 dsh-aux-vision）

| 维度 | modlens | vision-toolkit | vision-proxy | 237229953/dsh-vision | lakeofsky347 | dsh-aux-vision |
| --- | --- | --- | --- | --- | --- | --- |
| 触发方式 | read_image 工具 | 工具+Skill | 组合路由自动 | llm/stream 自动 | llm/stream 自动 | pre-step 自动 + llm/stream 兜底 |
| 主模型不变 | ✓ | ✓ | ✓（经组合路由） | ✓ | ✓ | ✓ |
| 准入守卫处理 | resolveModelInfo 相关 | — | 路由声明 image | **resolveModelInfo 包装**（与 dsh-aux-vision 同方案，注释明示「无官方扩展点」） | resolveModelInfo | resolveModelInfo 能力申报补丁 |
| UI 显示 | 工具结果 | 工具结果 | 描述替换 | **原图保留**（surface-replace） | — | 描述文本（局限） |
| 纯文本轮开销 | 无 | 无 | 无 | 无 | 无 | 无 |
| 视觉模型 | 本地 modlens CLI | 多模型 | 单 VLM 可配 | 配置 | 配置 | 配置链 + 自动发现（任意） |
| 缓存 | ✓ | — | — | ✓（前缀缓存） | ✓ | ✓（TTL+名额分配） |
| 批量/防滥用 | — | — | — | 并发去重 | — | batchMaxImages 未命中优先 |
| 降级 | ✓ | — | — | 失败不固化 | — | marker/error 可配 |
| 依赖 | commander/undici + CLI 引擎 | saxes/cordis/react | schemastery | **零依赖** | 零依赖 | **零依赖** |
| 成熟度 | ⭐1022 最早(02) | ⭐275 工具最全 | ⭐4 | ⭐0 但防御清单完备 | ⭐0 | ⭐0 |

## 结论与差距

1. **自动注入类中，237229953-create/dsh-vision 与 dsh-aux-vision 方案最接近**：同为
   resolveModelInfo 准入包装 + 自动转译 + 缓存 + 零依赖；核心差异在注入路径：
   - 它走 **llm/stream + surface-replace**：UI 保留原图 ✓，但首轮请求需改写（依赖 invariant
     时序：invariant 先于 append 通过）、需要防递归/并发去重/seq 反查等防御；
   - dsh-aux-vision 走 **pre-step**：首轮零改写、invariant 天然一致、实现更简单，但 UI 显示
     描述文本（用户可见的「占地方」问题）。
2. **可直接借鉴的改进点（v0.2 候选）**：把注入改为「保留原图 + surface-replace 落库」——
   pre-step 返回原图消息（UI 显示原图）+ 在请求构建前追加 surface-replace 描述事件
   （模型投影见描述）→ 同时解决 UI 占地方与日志文本化。可行性已核验：
   foldSurface 的 replace 只作用于模型投影（`packages/core/session/src/surface.ts`），
   UI 渲染原始事件流。
3. **差异化优势**：任意文本模型 + 任意视觉模型（配置链 + 自动发现）、名额分配（未命中优先）、
   纯文本轮零调用、pre-step 主路径的简单性——同类中不多见。
