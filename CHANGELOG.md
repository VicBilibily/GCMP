# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.25.30] - 2026-07-10

### 新增

- **Codex GPT-5.6 模型**：新增 GPT-5.6 Sol/Terra/Luna 三款模型配置，同步更新 README 模型列表（[#287](https://github.com/VicBilibily/GCMP/issues/287)）。

---

### Added

- **Codex GPT-5.6 models**: Added GPT-5.6 Sol/Terra/Luna model configs; updated README model listings ([#287](https://github.com/VicBilibily/GCMP/issues/287)).

## [0.25.29] - 2026-07-10

### 新增

- **FIM / NES 请求熔断器**：FIM 与 NES 补全请求新增熔断器机制（Circuit Breaker）。当请求连续失败达到阈值后自动暂停请求，冷却期后进入半开状态允许一次探测请求，成功则恢复、失败则重新熔断。支持手动重试/查看设置的通知弹窗，配置即时生效（[#279](https://github.com/VicBilibily/GCMP/issues/279)）。
- **Kimi For Coding · HighSpeed 模型**：月之暗面 Kimi For Coding 专业编程模型高速版，提供更快的代码生成速度，跟随会员套餐权益。

---

### Added

- **FIM / NES circuit breaker**: New circuit breaker mechanism for FIM and NES completion requests. When consecutive failures reach the threshold, requests are automatically paused. After a cooldown period, enters half-open state allowing one probe request — success restores service, failure re-trips the breaker. Includes notification popup with manual retry and settings navigation; configuration changes take effect immediately ([#279](https://github.com/VicBilibily/GCMP/issues/279)).
- **Kimi For Coding · HighSpeed model**: High-speed variant of Kimi For Coding, the professional coding model by MoonshotAI, offering faster code generation speed. Available with membership plan.

## [0.25.28] - 2026-07-09

### 新增

- **启动 Utility 模型配置引导**：检测到 VS Code 1.128+ 且通用辅助模型（`chat.utilityModel`/`chat.utilitySmallModel`）均未配置时，启动后弹窗引导用户手动设置或自动跟随主模型。避免使用非官方 Copilot 模型（BYOK/自定义提供商）时触发 "No utility model is configured" 报错（[#283](https://github.com/VicBilibily/GCMP/issues/283)）。

---

### Added

- **Startup utility model configuration guidance**: Detects VS Code 1.128+ with unconfigured utility models (`chat.utilityModel`/`chat.utilitySmallModel`); shows a startup dialog guiding users to configure models manually or auto-follow the main agent. Prevents "No utility model is configured" errors when using non-official Copilot models (BYOK/custom providers) ([#283](https://github.com/VicBilibily/GCMP/issues/283)).

## [0.25.27] - 2026-07-09

### 修复

- **恢复 github.copilot-chat 扩展依赖**：重新将 `github.copilot-chat` 声明为扩展硬依赖（`extensionDependencies`），修复因移除该依赖导致的 Chat 模型选择回退到 Copilot 模型的问题（[#284](https://github.com/VicBilibily/GCMP/issues/284)）。

---

### Fixed

- **Restored github.copilot-chat extension dependency**: Re-declared `github.copilot-chat` as a hard extension dependency (`extensionDependencies`), fixing chat model fallback to Copilot models caused by the dependency removal ([#284](https://github.com/VicBilibily/GCMP/issues/284)).

## [0.25.26] - 2026-07-09

### 新增

- **Grok 4.5 模型**：新增 xAI Grok 4.5 编程模型，`openai-responses` SDK 模式，`high` 默认推理强度，支持工具调用与图片输入（[#282](https://github.com/VicBilibily/GCMP/pull/282)）。

### 变更

- **Grok 模型参数调整**：更新 `grok-build-0.1` 等模型的 `maxInputTokens`/`maxOutputTokens`，统一 `maxOutputTokens` 为 32767（[#282](https://github.com/VicBilibily/GCMP/pull/282)）。

---

### Added

- **Grok 4.5 model**: New xAI Grok 4.5 programming model with `openai-responses` SDK mode, default `high` reasoning effort; supports tool calling and image input ([#282](https://github.com/VicBilibily/GCMP/pull/282)).

### Changed

- **Grok model parameter adjustments**: Updated `maxInputTokens`/`maxOutputTokens` for existing Grok models; unified `maxOutputTokens` to 32767 ([#282](https://github.com/VicBilibily/GCMP/pull/282)).

## [0.25.25] - 2026-07-09

### 修复

- **FIM/NES onDidChange 反馈循环导致请求自激（根因）**：移除 `provideInlineCompletionItems` 中自动触发和手动触发两条路径末尾的 `setTimeout(() => this.onDidChangeEmitter.fire(), 200)` 调用。这是 [#279](https://github.com/VicBilibily/GCMP/issues/279) 请求风暴的**根本原因**——每次补全完成后 VS Code 收到 `onDidChange` 通知，认为编辑器内容已变化，立即重新查询 `provideInlineCompletionItems` 创建新请求，形成永不停止的自激循环（[#279](https://github.com/VicBilibily/GCMP/issues/279)）。

### 变更

- **升级 @vscode/chat-lib 至 0.54.0**：从 `^0.47.0` 升级到固定版本 `0.54.0`；同步升级 `@types/vscode` 至 `^1.125.0`，最低 VS Code 引擎版本提升至 `>=1.125.0`。
- ~~**移除 extensionDependencies**：不再声明 `github.copilot-chat` 为扩展硬依赖，降低安装冲突和版本锁定风险（[#261](https://github.com/VicBilibily/GCMP/issues/261)）。~~

---

### Fixed

- **FIM/NES onDidChange feedback loop causing self-triggered request storm (root cause)**: Removed `setTimeout(() => this.onDidChangeEmitter.fire(), 200)` from both auto-trigger and manual-trigger paths in `provideInlineCompletionItems`. This was the **root cause** of the [#279](https://github.com/VicBilibily/GCMP/issues/279) request flood — after every completion, VS Code received an `onDidChange` notification, interpreted it as editor content change, and immediately re-queried `provideInlineCompletionItems`, creating a never-ending self-triggering loop ([#279](https://github.com/VicBilibily/GCMP/issues/279)).

### Changed

- **Upgraded @vscode/chat-lib to 0.54.0**: Pinned to `0.54.0` (from `^0.47.0`); upgraded `@types/vscode` to `^1.125.0`, minimum VS Code engine bumped to `>=1.125.0`.
- ~~**Removed extensionDependencies**: No longer declares `github.copilot-chat` as a hard extension dependency, reducing installation conflicts and version lock-in risks ([#261](https://github.com/VicBilibily/GCMP/issues/261)).~~

## [0.25.24] - 2026-07-08

### 修复

- **FIM/NES 编辑器失焦后仍持续发起请求**：修复编辑器失焦或切换到其他窗口后，FIM/NES 内联补全仍然持续发起 API 请求的问题。`InlineCompletionShim` 与 `InlineCompletionProvider` 两个入口均增加活动编辑器焦点检查，当请求文档非当前活动编辑器时直接返回，不再发起任何网络请求（[#279](https://github.com/VicBilibily/GCMP/issues/279)）。
- **移除冗余的 InlineCompletionItemProvider 重复注册**：`InlineCompletionProvider.activate()` 不再重复注册 `registerInlineCompletionItemProvider`，所有 FIM/NES 请求统一由 `InlineCompletionShim` 单入口分发，避免同一请求被触发两次导致的请求量翻倍。

---

### Fixed

- **FIM/NES requests continuing after editor loses focus**: Fixed an issue where FIM/NES inline completions kept sending API requests after the editor lost focus or the user switched to another window. Both `InlineCompletionShim` and `InlineCompletionProvider` entry points now check the active editor focus — when the requesting document is not the current active editor, the request is dropped immediately without any network call ([#279](https://github.com/VicBilibily/GCMP/issues/279)).
- **Removed redundant InlineCompletionItemProvider duplicate registration**: `InlineCompletionProvider.activate()` no longer registers a duplicate `registerInlineCompletionItemProvider`. All FIM/NES requests are now routed through the single `InlineCompletionShim` entry point, eliminating doubled request volume caused by two providers registered for the same pattern.

## [0.25.23] - 2026-07-08

### 修复

- **Responses API 缺失 content_part.added 自动注入**：某些 OpenAI 兼容网关仅发送 `response.output_text.delta` 或 `response.reasoning_text.delta` 而缺失前置的 `response.content_part.added` 事件，导致 OpenAI SDK 内部 `#accumulateResponse` 找不到 `content[index]` 而报错；handler 现已自动跟踪已见的 content part，并在检测到缺失时注入合成的 `content_part.added` 事件，恢复流式响应完整性。

---

### Fixed

- **Auto-inject missing content_part.added in Responses API**: Some OpenAI-compatible gateways only send `response.output_text.delta` or `response.reasoning_text.delta` without the preceding `response.content_part.added` event, causing OpenAI SDK's `#accumulateResponse` to fail looking up `content[index]`. The handler now tracks seen content parts and synthesizes the missing `content_part.added` event when detected, restoring streaming response integrity.

## [0.25.22] - 2026-07-04

### 新增

- **Compatible Provider 余额查询配置化**：自定义 Compatible 提供商现在可通过 `gcmp.providerOverrides` 的 `usage` / `usages` 字段配置多模式余额查询。支持 JSON 路径提取、加减运算、成功条件判断、错误消息提取，覆盖单余额、多金额/多余额查询场景。参考配置方式见 [src/utils/knownProviders.ts](src/utils/knownProviders.ts)。

### 变更

- **内置提供商余额查询统一化**：移除 AIPing、OpenRouter、SiliconFlow 三家的专用余额查询器实现，改用统一的 `usage` 字段配置，通过 JSON Schema 驱动声明式查询。配置集中管理于 `knownProviders.ts`，新增 `usageConfigResolver` 解析器与 `pathExtractor` JSON 路径提取工具。

---

### Added

- **Configurable balance queries for Compatible providers**: Custom compatible providers can now configure multi-mode balance queries via the `usage` / `usages` fields in `gcmp.providerOverrides`. Supports JSON path extraction, arithmetic operations, success condition checks, and error message extraction — covering single balance, multi-amount, and multi-balance query scenarios. See [src/utils/knownProviders.ts](src/utils/knownProviders.ts) for reference configurations.

### Changed

- **Unified balance query for built-in providers**: Removed dedicated balance queryer implementations for AIPing, OpenRouter, and SiliconFlow — replaced with a unified `usage` field configuration driven by JSON Schema. Configs centralized in `knownProviders.ts`; added `usageConfigResolver` and `pathExtractor` JSON path extraction utility.

## [0.25.21] - 2026-07-03

### 新增

- **ClinePass 提供商**：新增 ClinePass 大模型聚合平台，预置 GLM-5.2、Kimi-K2.7-Code、Kimi-K2.6、DeepSeek-V4-Pro、DeepSeek-V4-Flash、MiMo-V2.5、MiMo-V2.5-Pro、MiniMax-M3、Qwen3.7-Max、Qwen3.7-Plus 共 10 个模型（[#272](https://github.com/VicBilibily/GCMP/pull/272)）。

---

### Added

- **ClinePass provider**: New model aggregator platform with 10 preset models including GLM-5.2, Kimi-K2.7-Code, DeepSeek-V4 series, MiMo-V2.5 series, MiniMax-M3, and Qwen3.7 series ([#272](https://github.com/VicBilibily/GCMP/pull/272)).

## [0.25.20] - 2026-07-02

### 新增

- **LongCat 提供商**：新增 LongCat API 开放平台大模型提供商，预置 **LongCat-2.0** Agentic 模型（Anthropic SDK 协议、1M 上下文窗口、thinking 支持）。

### 变更

- **请求取消状态精细化**：所有 handler/provider 层取消请求时统一记录为 `cancelled` 状态，不再误计为 `failed`；cancelled 状态支持记录实际 token 用量（流式中途取消仍可获取部分 usage）；新增 `isCancellationError` 统一检测工具（深层嵌套 + 循环引用安全遍历）。
- **UI 统计视图增强**：Token 用量视图新增 cancelled 状态展示（🚫 图标），统计表格增加完成/失败/取消三列分解；成功率/失败率计算排除已取消请求，更准确反映系统可靠性。

### 修复

- **Responses API 流错误处理**：修复 `response.failed` 先于 `response.created` 到达时 OpenAI SDK 内部抛出异常、导致错误信息丢失的问题，改为在 `stream.done()` 外层捕获并正确填充到 `streamError`。

---

### Added

- **LongCat provider**: New native model provider for LongCat API, with preset **LongCat-2.0** Agentic model (Anthropic SDK protocol, 1M context window, thinking support).

### Changed

- **Refined cancellation status tracking**: All handler/provider layers now uniformly record cancelled requests as `cancelled` instead of incorrectly marking them as `failed`; cancelled status supports recording actual token usage (partial usage from mid-stream cancellation); added `isCancellationError` unified detection utility (deep nesting + circular reference safe traversal).
- **Enhanced statistics UI**: Token usage view now displays cancelled status (🚫 icon); stats table shows completion/failure/cancellation breakdown; success/failure rate calculation excludes cancelled requests for more accurate reliability metrics.

### Fixed

- **Responses API stream error handling**: Fixed an issue where OpenAI SDK internally threw an exception when `response.failed` arrived before `response.created`, causing error message loss; now caught at `stream.done()` and correctly propagated to `streamError`.

## [0.25.19] - 2026-07-01

### 新增

- **模型编辑器智能回填**：选中已知提供商时，BASE URL 字段按 SDK 模式自动填充默认地址；切换 SDK 模式时自动同步更新（覆盖 OpenAI / Anthropic 协议）。
- **新增已知提供商预置 baseUrl**：AIPing（`aiping.cn`）、OpenRouter（`openrouter.ai`）、硅基流动（`api.siliconflow.cn`）、MistralAI（`api.mistral.ai`），选中即自动填入。

### 变更

- **AIHubMix 端点迁移**：OpenAI 与 Anthropic baseUrl 从 `aihubmix.com` 迁移至 `api.inferera.com`，余额查询端点同步更新（[#267](https://github.com/VicBilibily/GCMP/issues/267)）。

---

### Added

- **Smart model editor auto-fill**: BASE URL is now automatically filled based on SDK mode when a known provider is selected; auto-updates when switching SDK modes (covers OpenAI / Anthropic protocols).
- **Preset baseUrls for known providers**: AIPing (`aiping.cn`), OpenRouter (`openrouter.ai`), SiliconFlow (`api.siliconflow.cn`), MistralAI (`api.mistral.ai`) — auto-filled on selection.

### Changed

- **AIHubMix endpoint migration**: OpenAI and Anthropic baseUrls migrated from `aihubmix.com` to `api.inferera.com`; balance query endpoint updated accordingly ([#267](https://github.com/VicBilibily/GCMP/issues/267)).

## [0.25.18] - 2026-06-30

### 新增

- **讯飞星辰 Astron**：新增 **XunFei Astron** 原生大模型提供商，支持 Coding Plan / Token Plan 双套餐，预置 **Spark X2**、**Spark-X2-Flash**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**、**DeepSeek-V3.2**、**GLM-5.2**、**GLM-5.1**、**GLM-5**、**GLM-4.7-Flash**、**Kimi-K2.6**、**Kimi-K2.5**、**MiniMax-M2.5**、**Qwen3.6-35B-A3B**、**Qwen3.5-35B-A3B**、**Qwen3.5-397B-A17B**、**Qwen3-Coder-Next-FP8**（implements [#249](https://github.com/VicBilibily/GCMP/issues/249)）。

### 修复

- **thinking 默认值修复**：将 `thinking` 选项默认值逻辑简化为 `thinkingOptions[0]`，修复某些模型列表顺序下默认值选取不正确的问题。
- **only-thinking 响应的空白占位符改为输出 DONE**：将原 `\n```\n```\n\n` 空块占位符改为输出 `DONE`，在消除聊天界面中大段空白的同时保留完整的流结束标识（fixes [#260](https://github.com/VicBilibily/GCMP/issues/260)）。

---

### Added

- **XunFei Astron**: New native model provider with Coding Plan / Token Plan support. Presets include **Spark X2**, **Spark-X2-Flash**, **DeepSeek-V4-Pro**, **DeepSeek-V4-Flash**, **DeepSeek-V3.2**, **GLM-5.2**, **GLM-5.1**, **GLM-5**, **GLM-4.7-Flash**, **Kimi-K2.6**, **Kimi-K2.5**, **MiniMax-M2.5**, **Qwen3.6-35B-A3B**, **Qwen3.5-35B-A3B**, **Qwen3.5-397B-A17B**, **Qwen3-Coder-Next-FP8** (implements [#249](https://github.com/VicBilibily/GCMP/issues/249)).

### Fixed

- **Thinking default value fix**: Simplified default logic to `thinkingOptions[0]`, fixing incorrect default selection in certain model list orders.
- **Blank placeholder for thinking-only responses changed to DONE**: The legacy `\n```\n```\n\n` empty-block placeholder is replaced with `DONE`, eliminating large blank areas in chat UI while preserving a clear stream-end signal (fixes [#260](https://github.com/VicBilibily/GCMP/issues/260)).

## [0.25.17] - 2026-06-30

### 修复

- ~~**移除 only-thinking 响应的空白占位符**：当模型只输出思维链（`reasoning_content`）无正文时，不再注入 `\n```\n```\n\n` 历史兼容占位符，消除聊天界面中的大段空白（fixes [#260](https://github.com/VicBilibily/GCMP/issues/260)）。~~

---

### Fixed

- ~~**Removed blank placeholder for thinking-only responses**: The legacy `\n```\n```\n\n` compatibility placeholder is no longer injected when the model outputs only reasoning content without text body, eliminating large blank areas in chat UI (fixes [#260](https://github.com/VicBilibily/GCMP/issues/260)).~~

## [0.25.16] - 2026-06-29

### 重构

- **统计刷新链路改为快照+签名缓存**：2 天前的数据由 requests.jsonl 快照替代，删除原始文件释放磁盘；新增签名缓存避免无意义重算与 I/O；UI 侧新增智能防抖，先渲染 HTML 再异步检查过期统计。
- **速度与首 Token 延迟统计增加异常样本过滤**：对速度样本增加上限 2000 tokens/s，首 Token 延迟下限从 0 提高到 10ms，排除缓存命中等极短响应对统计均值的干扰。

### 修复

- **Commit 消息生成入口互斥策略**：区分命令面板（全局串行）与 SCM 入口（按仓库互斥），允许跨仓库并发生成提交消息。

---

### Refactor

- **Stats refresh pipeline changed to snapshot + signature caching**: Data older than 2 days is now served by requests.jsonl snapshots, freeing disk space. Added signature caching to skip unnecessary recalculations. UI adds debounced smart refresh.
- **Anomalous speed and first-token latency filtering added**: Added a 2000 tokens/s cap on speed samples and raised the first-token latency floor from 0 to 10ms, eliminating cache-hit extremes from the mean calculation.

### Fixed

- **Commit message generation mutex strategy**: Differentiated between command palette (global serialization) and SCM entry points (per-repo mutual exclusion), allowing cross-repo concurrent commit message generation.

## [0.25.15] - 2026-06-26

### 新增

- **OpenCode 模型配置调整**：Go 套餐移除 GLM-5、MiniMax-M2.5、Qwen3.5-Plus；Zen 套餐新增 **GLM-5.2**、**DeepSeek-V4-Pro**

---

### Added

- **OpenCode model config updated**: Go plan removes GLM-5, MiniMax-M2.5, Qwen3.5-Plus; Zen plan adds **GLM-5.2**, **DeepSeek-V4-Pro**

## [0.25.14] - 2026-06-25

### 新增

- **`gcmp.providerOverrides` 支持已知/自定义/compatible 提供商基础覆盖**：schema 提示 + runtime 应用 customHeader/proxy，proxy 回退链兼容 `providerOverrides.compatible`，余额查询器匹配 compatible 全局 customHeader

---

### Added

- **`gcmp.providerOverrides` support for known/custom/compatible providers**: schema hints + runtime customHeader/proxy, proxy chain falls back to `providerOverrides.compatible`, balance queries respect compatible global customHeader

## [0.25.13] - 2026-06-25

### 新增

- **阿里云百炼**：[#255](https://github.com/VicBilibily/GCMP/issues/255) GLM-5.2、Kimi-K2.7-Code
- **阿里云百炼 TokenPlan**：Kimi-K2.7-Code

---

### Added

- **DashScope**: [#255](https://github.com/VicBilibily/GCMP/issues/255) GLM-5.2, Kimi-K2.7-Code
- **DashScope TokenPlan**: Kimi-K2.7-Code

## [0.25.12] - 2026-06-24

### 修复

- **工具调用场景下思考折叠与回复文本渲染错乱**：[#252](https://github.com/VicBilibily/GCMP/issues/252) 修复 `flushText()` 在 `endThinkingChain()` 之前被调用导致 VS Code Chat UI 将回复文本归入思考折叠区的问题。现已交换调用顺序，确保思考折叠关闭后再输出文本

---

### Fixed

- **Tool Call Thinking Fold Rendering Bug**: [#252](https://github.com/VicBilibily/GCMP/issues/252) Fixed `flushText()` being called before `endThinkingChain()` in tool call scenarios, causing VS Code Chat UI to collapse response text into the thinking fold. Swapped calls to close thinking fold before emitting text

---

## [0.25.11] - 2026-06-24

### 修复

- **会话追踪跨轮次丢失（sessionId 不一致）**：修复每轮对话都生成新 sessionId、无法进行会话级 token 统计的问题。根因是 `StatefulMarker` payload 中的 `completeThinking`/`completeSignature` 大字段包含大量特殊字符，超出 VS Code 序列化管道对自定义 DataPart 的容量限制（约 400B），导致静默截断 → `JSON.parse` 失败 → 下轮请求找不到前序 sessionId。现改用 base64url 编码 JSON payload，彻底规避特殊字符截断问题，同时保留了完整 thinking/signature 的跨轮次回传能力

### 新增

- **Token 用量面板请求记录表支持会话快速筛选**：在「全部会话」视图下，每条请求的令牌列下方显示可点击的 session 短 ID（`#abc1234`），点击即可直接筛选到该会话详情，替代左侧会话列表的手动查找
- **实时 token 增量显示**：`.output-tokens` 实时列显示最近一次 flush 的 token delta，流式过程中直观反映输出节奏

### 重构

- **小米 MiMo 与 DeepSeek-V4 思考回放策略统一**：小米 MiMo 的 `missingReasoningFieldPolicy` 从 `tool-calls-only` 升级为 `always`，与 DeepSeek-V4 一致。合并 `isMiMoReasoningModel` 独立函数到主匹配分支，消除重复代码。确保两类模型在多轮对话中即使无 thinking 内容也始终注入空白占位符，维持思维链连续性

---

### Fixed

- **Session Tracking Lost Across Turns (Inconsistent sessionId)**: Fixed each request generating a new `sessionId` instead of reusing the conversation's existing one. Root cause: `completeThinking`/`completeSignature` in `StatefulMarker` contain special characters that exceed VS Code's serialization limit (~400B) for custom DataPart MIME types, causing silent truncation → `JSON.parse` failure → next turn couldn't find the previous `sessionId`. Migrated to base64url-encoded JSON payload to completely avoid special character truncation while preserving full thinking/signature replay across turns

### Added

- **Session Quick-Filter in Token Usage Table**: In "All Sessions" view, each request's token column now shows a clickable session short ID (`#abc1234`). Clicking it directly filters to that session's details, eliminating manual hunting through the session sidebar
- **Live Token Delta Display**: The `.output-tokens` live column shows the latest flush delta, giving a real-time view of output cadence during streaming

### Refactored

- **Unified MiMo & DeepSeek-V4 Reasoning Replay Policy**: Upgraded Xiaomi MiMo's `missingReasoningFieldPolicy` from `tool-calls-only` to `always`, matching DeepSeek-V4. Inlined the standalone `isMiMoReasoningModel` function into the main matching branch, eliminating duplicate code. Both model families now always inject a blank placeholder even without thinking content, maintaining thinking chain continuity across turns

## [0.25.10] - 2026-06-24

### 修复

- **中途打开面板实时指标丢失**：[#250](https://github.com/VicBilibily/GCMP/issues/250) 修复在请求流式传输中途打开 Token 用量面板时，实时指标因订阅晚于事件发送而丢失的问题；引入活跃请求事件快照机制（`getActiveMetricsSnapshot`），在面板打开或日期切换时自动补发当前流式状态

### 重构

- **移除实时指标占位行**：删除 `liveMetricsRenderer` 中的流式占位行机制，大幅简化渲染逻辑，减少冗余状态维护

---

### Fixed

- **Live Metrics Lost When Panel Opened Mid-Stream**: [#250](https://github.com/VicBilibily/GCMP/issues/250) Fixed real-time metrics being lost when the Token Usage panel is opened mid-stream — introduced `getActiveMetricsSnapshot()` to cache the latest state of active requests and replay it when the panel opens or switches dates

### Refactored

- **Removed Live Metrics Placeholder Rows**: Eliminated the streaming placeholder row mechanism in `liveMetricsRenderer`, greatly simplifying rendering logic and reducing redundant state management

## [0.25.9] - 2026-06-23

### 新增

- 新增模型级 `reasoningDefault` 配置项，可指定 `reasoningEffort` 的默认值，模型编辑器同步新增「默认推理强度」下拉框
- 火山方舟新增 **Ark-Code-Latest**（Coding/Agent Plan，Auto 模式）、**Doubao-Seed-Evolving**、**Doubao-Seed-2.1-turbo/pro** 预置模型
- 小米 MiMo 新增 **MiMo-V2.5-Pro-UltraSpeed** 预置模型

---

### Added

- New model-level `reasoningDefault` option to override the default of `reasoningEffort`; model editor adds a matching dropdown
- Volcengine adds **Ark-Code-Latest** (Coding/Agent Plan, Auto), **Doubao-Seed-Evolving**, **Doubao-Seed-2.1-turbo/pro** presets
- Xiaomi MiMo adds **MiMo-V2.5-Pro-UltraSpeed** preset

## [0.25.8] - 2026-06-23

### 优化

- **视觉模型配置失效自动恢复**：当 `gcmp.vision.model` 配置的模型不可用时（如 API Key 失效、模型被禁用），自动拉起模型选择向导让用户重选，取消则静默终止
- **视觉模型选择向导支持 Copilot**：当 `provider` 已为 `copilot` 时，向导会列出可用 Copilot 多模态模型，便于已选 Copilot 的用户切换模型

### 修复

- **取消向导污染模型上下文**：`BaseVisionTool` 现识别 `CancellationError` 原样上抛，避免用户关闭向导被错误包装为「图片分析失败」反馈给模型
- **Xiaomi MiMo 模型清理**：移除已下线的 **MiMo-V2-Flash** 预置模型

---

### Improved

- **Vision Model Auto-Recovery**: When the configured `gcmp.vision.model` is unavailable (e.g. API key revoked, model disabled), the selection wizard is auto-launched for the user to re-pick; cancelling silently aborts
- **Vision Wizard Supports Copilot**: When `provider` is `copilot`, the wizard lists available Copilot multimodal models for switching

### Fixed

- **Wizard Cancellation Polluting Context**: `BaseVisionTool` now recognizes `CancellationError` and re-throws it as-is, preventing the "image analysis failed" message from being sent to the model when the user closes the wizard
- **Xiaomi MiMo Model Cleanup**: Removed the delisted **MiMo-V2-Flash** preset

## [0.25.7] - 2026-06-23

### 新增

- **视觉分析工具支持 GitHub Copilot 原生模型**：`gcmp.vision.model` 现支持配置为 GitHub Copilot 原生多模态模型，将 `provider` 设为 `copilot` 即可使用 Copilot 订阅内的视觉模型驱动 `#gcmpUiToArtifact`、`#gcmpDiagnoseErrorScreenshot` 等全部视觉分析工具；辅助工具模型设置面板在已选择 Copilot 提供商时会自动列出可用的 Copilot 视觉模型
- **Charm Hyper 模型预设扩充**：[#247](https://github.com/VicBilibily/GCMP/pull/247) 新增 5 个模型预设：**Qwen3.7-Plus**、**Llama-4-Maverick-17B-128E-Instruct-FP8**、**Llama-3.3-70B-Instruct**、**Qwen3-Coder-480B-A35B-Instruct-INT4-Mixed-AR**、**Qwen3-Next-80B-A3B-Instruct**

---

### Added

- **Vision Tool Support for GitHub Copilot Native Models**: `gcmp.vision.model` now supports GitHub Copilot native multimodal models — set `provider` to `copilot` to drive all vision analysis tools (`#gcmpUiToArtifact`, `#gcmpDiagnoseErrorScreenshot`, etc.) with Copilot-subscribed vision models; the auxiliary tool model settings panel automatically lists available Copilot vision models when the Copilot provider is selected
- **Charm Hyper Model Presets Expansion**: [#247](https://github.com/VicBilibily/GCMP/pull/247) Added 5 new model presets: **Qwen3.7-Plus**, **Llama-4-Maverick-17B-128E-Instruct-FP8**, **Llama-3.3-70B-Instruct**, **Qwen3-Coder-480B-A35B-Instruct-INT4-Mixed-AR**, **Qwen3-Next-80B-A3B-Instruct**

## [0.25.6] - 2026-06-23

### 新增

- **请求记录实时指标**：[#244](https://github.com/VicBilibily/GCMP/pull/244) Token 消耗统计面板的请求记录现支持流式阶段实时展示首流延迟（TTFT）与输出耗时（TPOT），完成后由真实 usage 自然刷新
- **实时输出 token 估算**：流式阶段基于 tokenizer 实时估算输出 token 与输出速度（tokens/s），包含工具调用的完整结构开销（函数名、JSON 包装层等），预估与实际计费差距控制在 ±15% 以内；输出列以"最近一次接收的预估增量"（`+xx tks`）形式展示

---

### Added

- **Real-time Request Metrics**: [#244](https://github.com/VicBilibily/GCMP/pull/244) Request records in the Token usage panel now display time-to-first-token (TTFT) and time-per-output-token (TPOT) during streaming, naturally refreshed by actual usage once completed
- **Real-time Output Token Estimation**: Streaming-phase output tokens and output speed (tokens/s) are estimated in real time via tokenizer, including full tool call structural overhead (function name, JSON wrapper, etc.); estimation stays within ±15% of actual billing; output column shows the "last received estimation delta" (`+xx tks`)

## [0.25.5] - 2026-06-22

### 修复

- **视觉工具 compatible 提供商报错**：[#246](https://github.com/VicBilibily/GCMP/issues/246) 修复视觉分析工具在 `gcmp.vision.model` 配置为 `compatible` 提供商时报 `Vision model not found` 的问题；compatible 提供商现通过 `CompatibleModelManager` 查找动态模型列表，与提交消息生成器逻辑保持一致

---

### Fixed

- **Vision Tool Failure with Compatible Provider**: [#246](https://github.com/VicBilibily/GCMP/issues/246) Fixed `Vision model not found` error when `gcmp.vision.model` points to a `compatible` provider; compatible models are now resolved via `CompatibleModelManager`, matching the commit message generator logic

## [0.25.4] - 2026-06-22

### 优化

- **全局代理配置适用范围调整**：[#245](https://github.com/VicBilibily/GCMP/issues/245) 将 `gcmp.proxy` 的配置作用域从 `application` 调整为 `machine`

---

### Improved

- **Global Proxy Scope Adjustment**: [#245](https://github.com/VicBilibily/GCMP/issues/245) Changed `gcmp.proxy` configuration scope from `application` to `machine`

## [0.25.3] - 2026-06-22

### 修复

- **兼容模型创建时模型 ID 无法填写**： [#243](https://github.com/VicBilibily/GCMP/issues/243) 修复在「管理 Compatible 模型」→「添加新模型」对话框中，模型 ID 输入框始终为只读导致无法新建模型的问题。

---

### Fixed

- **Compatible Model ID Field Not Editable When Creating**: Fixed the issue where the Model ID input in "Manage Compatible Models" → "Add new model" was always read-only, making it impossible to create new models.

## [0.25.2] - 2026-06-21

### 优化

- **视觉工具提示词精简**：精简视觉工具指引文案，明确允许使用 GCMP 视觉工具或其他合适的外部工具读取图片，同时保留禁止 VS Code 内置文件工具直接读取图片文件的约束

---

### Improved

- **Vision Tool Prompt Streamlining**: Streamlined vision tool guide copy to explicitly allow reading images with GCMP vision tools or other suitable external tools, while keeping the restriction against using VS Code built-in file tools to inspect image files directly

## [0.25.1] - 2026-06-21

### 修复

- **视觉工具路径解析**：视觉分析工具现在直接接收图片缓存的完整绝对路径，移除了短路径（`sessionId/hash.ext`）传递与 `VisionCache.resolveShortPath()` 解析逻辑，避免部分模型对路径进行拼接猜测导致图片读取失败

---

### Fixed

- **Vision Tool Path Resolution**: Vision analysis tools now receive the full absolute cache path directly; removed short path (`sessionId/hash.ext`) passing and `VisionCache.resolveShortPath()` parsing to prevent some models from path splicing/guessing and failing to read images

## [0.25.0] - 2026-06-21

### 新增

- **API Key 跨设备同步（GitHub Gist）**：新增 `gcmp.sync.configure` 命令，支持通过 GitHub Gist 加密同步 API Key；使用 VS Code 内置 GitHub 认证获取 `gist` scope，AES-256-GCM 加密，密钥通过 scrypt 派生
- **视觉分析工具集**：新增 7 个视觉分析工具（`#gcmpUiToArtifact`、`#gcmpExtractTextFromScreenshot`、`#gcmpDiagnoseErrorScreenshot`、`#gcmpUnderstandTechnicalDiagram`、`#gcmpAnalyzeDataVisualization`、`#gcmpUiDiffCheck`、`#gcmpAnalyzeImage`），统一由 `gcmp.vision.model` 配置的多模态模型驱动
- **辅助工具模型设置面板**：新增 `GCMP: 设置辅助工具模型` 命令与可视化面板，统一配置 Commit / Vision / Utility / Copilot Agent 模型
- **Copilot 请求来源分类**：新增 `requestKind` 分类器，用于区分主 Agent、终端命令、代码解释、搜索子 Agent 等请求类型，并据此控制子请求思考模式

### 优化

- **提交消息生成命令统一**：新增 `gcmp.commit.generateMessage` 系列命令，统一根据 staged / working tree 变更生成提交消息的入口
- **模型编辑器重构**：`modelEditor` 从单文件 JS 迁移为 TS 模块化结构，新增 `modelsEndpoint` 下拉预设
- **流式输出缓冲重构**：抽离 `signatureBuffer`、`textBuffer`、`thinkingBuffer`、`toolCallAccumulator` 专用 Buffer 类

### 修复

- **工具结果过滤**：统一修复 OpenAI（Chat Completions / Responses / 自定义 SSE）与 Gemini 模式下工具结果中 `cache_control`、`stateful_marker`、`usage` 等内部 DataPart 被错误序列化为 JSON 污染模型上下文的问题
- **CLI 版本检测**：为 CLI 版本检测添加超时保护
- **Leader 释放竞态**：修复 `leaderElectionService.stop()` 中 `_isLeader=false` 与 `globalState.update` 顺序不当导致的 Leader 信息残留窗口
- **MCP 缓存键统一**：统一 DashScope / StepFun / Zhipu MCP 客户端缓存键，加入 endpoint 维度，避免切换 endpoint 后复用旧连接

---

### Added

- **API Key Cross-Device Sync (GitHub Gist)**: Added `gcmp.sync.configure` command to encrypt and sync API Keys via GitHub Gist; uses VS Code built-in GitHub authentication for `gist` scope, AES-256-GCM encryption, and scrypt key derivation
- **Vision Analysis Toolset**: Added 7 vision analysis tools (`#gcmpUiToArtifact`, `#gcmpExtractTextFromScreenshot`, `#gcmpDiagnoseErrorScreenshot`, `#gcmpUnderstandTechnicalDiagram`, `#gcmpAnalyzeDataVisualization`, `#gcmpUiDiffCheck`, `#gcmpAnalyzeImage`), all driven by the multimodal model configured in `gcmp.vision.model`
- **Auxiliary Model Settings Panel**: Added `GCMP: Set Auxiliary Tool Models` command and visual panel to uniformly configure Commit / Vision / Utility / Copilot Agent models
- **Copilot Request Kind Classification**: Added `requestKind` classifier to distinguish main agent, terminal commands, code explanation, search sub-agents, etc., and control reasoning mode for sub-requests

### Improved

- **Commit Message Generation Commands Unified**: Added `gcmp.commit.generateMessage` command family to unify the entry points for generating commit messages from staged / working tree changes
- **Model Editor Refactor**: Migrated `modelEditor` from a single JS file to a TS modular structure, added `modelsEndpoint` dropdown presets
- **Streaming Output Buffer Refactor**: Extracted dedicated buffer classes (`signatureBuffer`, `textBuffer`, `thinkingBuffer`, `toolCallAccumulator`)

### Fixed

- **Tool Result Filtering**: Fixed inconsistent handling of internal DataParts (`cache_control`, `stateful_marker`, `usage`, etc.) in tool results across OpenAI (Chat Completions / Responses / custom SSE) and Gemini modes; these parts are now skipped instead of being serialized as JSON noise
- **CLI Version Detection**: Added timeout protection for CLI version detection
- **Leader Release Race**: Fixed leader info residue window caused by incorrect ordering of `_isLeader=false` and `globalState.update` in `leaderElectionService.stop()`
- **MCP Cache Key Unification**: Unified MCP client cache keys for DashScope / StepFun / Zhipu to include the endpoint dimension, preventing stale connection reuse after endpoint changes

## 历史版本（仅保留功能日志）

### 0.23.0 - 0.24.16 (2026-05-30 - 2026-06-21)

- **Grok Build CLI (OAuth) 接入**：[#200](https://github.com/VicBilibily/GCMP/pull/200) 新增 `gcmp.grok` 提供商，支持通过 Grok Build OAuth 登录态访问 xAI 编程模型；新增 **grok-build-0.1** 模型，支持工具调用与图片输入
- **OpenCode 新提供商**：新增 `gcmp.opencode` 提供商，支持 Go 订阅与 Zen 按量付费，覆盖 GLM-5.1、Kimi-K2.6、DeepSeek-V4-Pro、MiniMax-M3 等 20+ 模型；流式模式后续切换为 `openai-sse`
- **全局代理链路统一**：新增 `gcmp.proxy`、`gcmp.tls.useSystemCertificates`，扩展提供商与模型级 `proxy` 覆盖；统一聊天请求、FIM/NES、模型发现、搜索、图片理解、状态栏查询、CLI OAuth 刷新及 MCP 客户端的代理感知链路
- **系统代理自动识别**：新增 Windows Registry 与 macOS `scutil` 系统代理检测，无显式配置时自动沿用系统设置
- **运行环境升级**：扩展运行基线升级至 Node.js `22.22.3`，`@vscode/chat-lib` 升级至 `0.47.0`
- **Charm Hyper 提供商**：[#218](https://github.com/VicBilibily/GCMP/pull/218) 新增 Charm Hyper 提供商，预置 DeepSeek-V4、Qwen3.6/3.7、GLM-5/5.1、Kimi-K2.5/2.6、MiniMax-M2.7 等 13 个模型
- **StepFun 提供商**：[#232](https://github.com/VicBilibily/GCMP/issues/232) 新增阶跃星辰开源大模型系列，内置 Step Reasoning 推理模式及 `#stepfunWebSearch` MCP 联网搜索工具
- **Ant Ling 提供商**：新增蚂蚁集团开源 MoE 架构大语言模型家族，采用 Anthropic 模式接入，预置 Ling-2.6-1T、Ling-2.6-flash、Ring-2.6-1T 三个模型
- **多日消耗分析视图**：用量面板新增「多日分析」标签页，支持跨日期趋势统计与可视化
- **工具上下文管理器（ToolContextManager）**：新增统一的管理器，通过 VS Code `setContext` 维护工具可用性上下文键，并实时监听 API Key 变更事件自动更新工具可见性
- **智能模型过滤**：提供商模型列表根据已配置的 API Key 过滤，仅展示可用模型
- **OpenRouter 网关 reasoning 字段兼容**：[#221](https://github.com/VicBilibily/GCMP/issues/221) 兼容 `delta.reasoning` / `delta.reasoning_details` 字段解析
- **重试开关**：新增 `gcmp.retry.enabled`（默认 `true`）
- **移除 Gemini CLI 提供商**：移除基于 CLI 认证的 Gemini 提供商支持

### 0.22.0 - 0.22.27 (2026-04-24 - 2026-05-30)

- **Commit 消息生成**：新增 System Role 提示词、默认优先读取暂存区并在生成后提示实际来源，同时加入 diff 过滤层与 `gcmp.commit.sensitiveFiles` 自定义敏感文件规则
- **Compatible 命名收敛**：界面与文档中的 `OpenAI / Anthropic Compatible` 统一简化为 `Compatible`
- **国际化与展示**：新增中英双语界面自动切换、ChatGPT 用量重置倒计时、Copilot 上下文窗口 `usage` 数据回传，并将默认 `gcmp.maxTokens` 提升至 `32000`
- **兼容层与流式稳定性**：修复 OpenAI `/responses` 在缺少 `Content-Type`、`response.failed` 事件上抛异常、JSON 错误体误判 SSE 等兼容性问题，并补充 `limit exceeded` 重试识别
- **工具调用与推理回放**：修复工具调用参数分片去重/解析问题；重构 reasoning replay 策略，修复多轮工具调用中的推理内容丢失及提交场景下关闭思考参数冲突

### 0.21.0 - 0.21.20 (2026-03-27 - 2026-04-23)

- **模型配置能力**：新增模型级 `thinking`、`reasoningEffort` 选项，允许手动调整模型思考模式及思考强度
- **请求重试机制**：统一由通用 Provider 处理自动重试，新增 `gcmp.retry.maxAttempts` 配置项

### 0.20.0 - 0.20.11 (2026-03-05 - 2026-03-23)

- **Codex CLI 认证支持**：新增 OpenAI Codex (Codex CLI) 提供商支持

### 0.19.0 - 0.19.17 (2026-02-12 - 2026-02-28)

- **功能优化**：重构 Token 统计缓存机制、优化状态栏统一显示剩余百分比、API Key 输入体验优化、Anthropic cache_control 兼容性改进

### 0.18.0 - 0.18.30 (2026-01-23 - 2026-02-11)

- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
- **Token 统计**：新增完整的 Token 消耗统计系统，包括平均输出速度、首 Token 延迟、小时统计图表等可视化功能
- **MistralAI**：新增 MistralAI 提供商支持，支持 Codestral 系列模型 FIM/NES 代码补全功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
