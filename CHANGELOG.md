# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.26.4] - 2026-07-21

### 新增

- **1M 上下文模型新增 192K 窗口档位**：覆盖全部内置 provider 的 1M 模型；火山方舟按量版 `Doubao-Seed-Evolving` 同步补齐窗口选择。
- **128K 阶梯定价模型新增窗口选择**：dashscope `Qwen3-Max` / `Qwen3-Coder-Next` 与火山方舟 Doubao-Seed 系列（CodingPlan / AgentPlan / 按量）新增 128K 档，可锁定在 128K 以内避免触达高阶梯价。

### 变更

- **Grok 4.5 窗口档位调整**：原 200K 档调整为 256K / 192K 档（含 OpenCode Zen）。

---

### Added

- **192K window tier for 1M-context models**: Applied to all 1M models across built-in providers; Volcengine pay-as-you-go `Doubao-Seed-Evolving` also gains window selection.
- **Window selection for 128K-tiered pricing models**: DashScope `Qwen3-Max` / `Qwen3-Coder-Next` and Volcengine Doubao-Seed series (CodingPlan / AgentPlan / pay-as-you-go) now offer a 128K tier, locking usage below the 128K pricing threshold.

### Changed

- **Grok 4.5 window tiers adjusted**: The former 200K tier is replaced by 256K / 192K tiers (including OpenCode Zen).

## [0.26.3] - 2026-07-20

### 新增

- **原生工具配置支持透传 provider 特有选项**：`nativeToolConfig` 除 `type` 外不再限制固定字段，允许传入 provider 特有的额外选项（如 `x_search`、`remote_mcp`）并按原样透传至 Responses API 请求体；`web_search` 的 GCMP 内部字段仍转换为标准 API 格式（[#311](https://github.com/VicBilibily/GCMP/issues/311)）。
- **Grok 4.5 启用 web_search 原生工具**：Grok 4.5 模型开启原生联网搜索能力。

### 修复

- **Agents 窗体与普通窗口双主实例冲突**：Agents 窗体的 `globalState` 与普通窗口隔离，导致双方各自当选 Leader（[#310](https://github.com/VicBilibily/GCMP/issues/310)）。现改为 Agents 窗体不参与选举，通过临时目录下的 Leader 发现文件以纯客户端连接普通窗口的 IPC Server。

---

### Added

- **Native tool configs support provider-specific options**: `nativeToolConfig` no longer restricts fields beyond `type`; provider-specific extra options (e.g. `x_search`, `remote_mcp`) are passed through to the Responses API request body as-is, while GCMP's internal `web_search` fields are still converted to the standard API format ([#311](https://github.com/VicBilibily/GCMP/issues/311)).
- **Grok 4.5 enables the web_search native tool**: The Grok 4.5 model now has native web search enabled.

### Fixed

- **Duplicate leader instances across Agents window and editor windows**: The Agents window's `globalState` is isolated from regular windows, causing both sides to elect themselves as Leader ([#310](https://github.com/VicBilibily/GCMP/issues/310)). The Agents window no longer participates in the election and instead connects to the regular window's IPC server as a pure client via a leader discovery file in the temp directory.

## [0.26.2] - 2026-07-19

### 新增

- **ClinePass 新增 Kimi-K3 模型**：新增 `cline-pass/kimi-k3`，支持 1M 上下文、视觉理解与工具调用。
- **OpenCode Go 新增 Kimi-K3 模型**：新增 `kimi-k3-go`，支持 1M 上下文、视觉理解与工具调用。

---

### Added

- **ClinePass adds Kimi-K3 model**: Added `cline-pass/kimi-k3` with 1M context, vision input, and tool calling.
- **OpenCode Go adds Kimi-K3 model**: Added `kimi-k3-go` with 1M context, vision input, and tool calling.

## [0.26.1] - 2026-07-19

### 新增

- **阿里云百炼 Token Plan 个人版支持**：新增 `dashscope-token-personal` 密钥类型与配套模型接入。Token Plan 个人版与团队版共用接入点（OpenAI Responses / Anthropic 兼容协议），但使用相互独立的 `sk-sp-` 专属密钥，需在配置向导或 `gcmp.dashscope.setPersonalTokenPlanApiKey` 命令中单独设置。个人版首批接入 qwen3.8-max-preview、qwen3.7-max、qwen3.7-plus、qwen3.6-flash、glm-5.2、deepseek-v4-pro 六款文本模型。
- **新增 Qwen3.8-Max-Preview 预览旗舰模型**：Token Plan 团队版与个人版同步新增 `Qwen3.8-Max-Preview` 模型，支持视觉理解、思考模式与 `web_search` / `web_extractor` 原生工具调用（Responses API）。该模型当前仅限 Token Plan 套餐可用，套餐内调用以 Credits 统一计量，官方暂未公布按 Token 单价，因此暂不提供成本估算展示。

### 变更

- **Token Plan 密钥命名区分团队版与个人版**：原 `dashscope-token` 密钥在配置向导、命令标题与 Gist 同步显示名中统一标注为团队版（Team），避免与新增的个人版密钥混淆。
- **启用原生工具的模型移除思考开关**：百炼在注入 `web_search` / `web_extractor` 原生工具时不支持关闭思考，移除相关模型（按量计费 qwen3.7/qwen3.6/qwen3.5 系列及 Token Plan 对应模型）的 `thinking` 配置项，统一遵循服务端默认思考行为。

---

### Added

- **AliDashScope Token Plan (Personal) support**: Added the `dashscope-token-personal` key type with its own model set. Token Plan Personal shares the same endpoints as the Team edition (OpenAI Responses / Anthropic compatible protocols) but uses a separate `sk-sp-` dedicated key, configurable via the setup wizard or the `gcmp.dashscope.setPersonalTokenPlanApiKey` command. The first batch of Personal models includes qwen3.8-max-preview, qwen3.7-max, qwen3.7-plus, qwen3.6-flash, glm-5.2, and deepseek-v4-pro.
- **New Qwen3.8-Max-Preview flagship preview model**: Added `Qwen3.8-Max-Preview` to both Token Plan (Team) and Token Plan (Personal), with vision input, thinking mode, and native `web_search` / `web_extractor` tool calls (Responses API). The model is currently exclusive to Token Plan and billed in Credits; since no official per-token price is published yet, cost estimation is not shown for it.

### Changed

- **Token Plan key naming distinguishes Team and Personal editions**: The existing `dashscope-token` key is now labeled as Token Plan (Team) in the setup wizard, command titles, and Gist sync display names to avoid confusion with the new Personal key.
- **Removed thinking toggle for models with native tools**: Bailian does not support disabling thinking when native `web_search` / `web_extractor` tools are injected; removed the `thinking` option from affected models (pay-as-you-go qwen3.7/qwen3.6/qwen3.5 series and corresponding Token Plan models), deferring to the server's default thinking behavior.

## [0.26.0] - 2026-07-19

### Token 定价与成本估算

- **[新增] Token 定价与客户端成本估算**：支持通过内置模型配置和 `gcmp.providerOverrides.<provider>.models[].tokenPricing` / `gcmp.compatibleModels[].tokenPricing` 为模型配置输入、输出、缓存读取、缓存写入等 Token 定价，并按峰谷时段、服务等级（`serviceTier`）和上下文大小（`contextSizeMin`）应用不同价格。预估成本会内联显示在 Token 数量下方，状态栏、详情页和多日趋势页均可查看；新增 `formatCostBreakdownLog` 日志输出，便于个人参考与核对。
- **[新增] 双币种成本展示**：定价配置支持 USD/RMB 双币种并列，按模型原生结算币种标记展示；状态栏（中文环境）、详情页、侧边栏日期列表与会话记录、多日趋势页均支持成本双币显示，并新增 USD/RMB 货币切换视图。
- **[新增] 多日视图成本展示**：多日趋势页新增成本趋势折线图与成本卡片汇总，优化 Token 与成本格式化工具函数。
- **[新增] 增量 Token 预估**：基于上一轮 API 实际用量做增量预估，消除长上下文中累积估算误差。
- **[变更] 定价配置结构优化**：`pricing` 字段统一支持对象形式与数组简写，可直接表达输入、输出、缓存读取、缓存写入价格，并兼容现有对象配置。
- **[变更] 上下文阈值分档统一**：上下文定价阈值统一按 API 实际输入 Token（含缓存）判定。

### 多窗口跨实例协同

- **[新增] 跨实例状态同步**：新增 Leader/Follower 跨实例通信模块，基于本地 IPC 广播事件在多 VS Code 窗口间同步状态栏、实时指标、配置变更和 API Key 变更，IPC 不可用时自动降级到文件系统轮询；支持 Leader 卸任通知和推荐下一任 Leader，无缝切换主实例。Leader 实例串行化 stats 写盘并响应 Follower 的 `statsRefreshRequested` 委托，避免多实例并发覆盖，并辅以每分钟周期兜底刷新今日 stats；过期数据清理统一由 Leader 执行，状态栏可显示主/子实例角色标识。
- **[新增] CLI 凭证跨实例单点刷新**：多窗口下由 Leader 实例统一执行 CLI OAuth 令牌刷新并以原子写入更新凭证文件，Follower 通过跨实例委托等待刷新回执；委托超时后先重读凭证文件并检测 Leader 心跳，仅在 Leader 失联时才本地兜底刷新，避免 refresh_token 单次轮换被并发刷新作废。ChatGPT 状态栏用量查询同步接入该通道。

### 状态栏与用量展示

- **[新增] Kimi 加油包钱包查询**：月之暗面 Kimi 会员套餐的加油包（Top-up Wallet）余额查询与状态栏展示，支持查看加油包额度与到期时间。
- **[新增] ClinePass 用量查询状态栏**：新增 ClinePass 套餐周期剩余用量、重置时间和总利用率的状态栏展示。
- **[新增] 输出速度鲁棒统计与重置倒计时**：输出速度等实时指标改用基于 MAD 加权均值的鲁棒统计量剔除离群值，状态栏用量表新增套餐重置倒计时列。
- **[变更] 上下文窗口状态栏简化**：饼图图标直观反映当前会话上下文窗口占用比例（0/8 ~ 8/8），悬停即可查看模型名称、占用百分比、Token 用量和请求来源类型，移除了细分类别拆解与状态缓存。
- **[变更] Token 成本内联展示**：状态栏表格、详情页提供商统计表和最近请求记录中的 Token 数量下方内联显示预估成本，移除独立成本列，节省横向空间。
- **[变更] 状态栏表格列结构调整**：状态栏每日统计弹窗合并消耗 Tokens 列与成本列，简化表头为「输入(+缓存)+输出=消耗Tokens」，缓存命中与输入 Token 成本拆分展示；同步调整 Token 输入输出格式化并清理冗余的格式化工具函数。
- **[变更] 通用请求完成后统一触发状态栏延迟刷新**：所有提供商的模型请求完成后，统一通过 `TokenUsageStatusBar.triggerDelayedUpdate` 延迟刷新 Token 消耗展示，避免高频请求导致的频繁 I/O。

### 联网搜索与原生工具

- **[新增] 原生工具配置**：新增 `nativeTools` 配置项，支持向 OpenAI Responses API 注入内置工具（如 `web_search`、`web_extractor`）；与 `webSearchTool` 叠加注入，重复配置时以 `nativeTools` 为准；仅 `sdkMode=openai-responses` 生效，`anthropic` 模式仅取其中的 `web_search` 项。模型编辑器新增对应 JSON 配置字段与实时验证。
- **[新增] 联网搜索工具**：`webSearchTool` 从布尔值扩展为对象配置（`maxUses`/`allowedDomains`/`blockedDomains`/`userLocation`）；新增 `openai-responses` 模式下原生 `web_search` 工具注入与 `url_citation`/`web_search_call` 事件处理；模型编辑器新增 `webSearchToolConfig` JSON 配置字段与实时验证。为 Codex、火山引擎 GLM 系列模型默认启用联网搜索。

### 重试与错误处理

- **[新增] 错误重试分类器**：新增 `Codex` 和 `Responses API` 的 `rate_limits` / `snapshot_bootstrap` 等重试条件判定，覆盖限流和快照引导失败场景。
- **[修复] 永久性错误不再误入重试**：修复日/月硬配额耗尽、账单或套餐超限、请求超出模型上下文限制等永久性错误被误判为限流而反复重试的问题；无限重试模式（`maxAttempts=-1`）新增 30 分钟总时长兜底上限。
- **[修复] OpenAI 流式 keepalive 心跳过滤**：修复网关 keepalive 心跳事件在 `response.created` 之前进入 Responses SDK 流导致崩溃的问题。

### 调试可观测

- **[新增] HAR 请求录制**：新增 `gcmp.debug.captureHar` 与 `gcmp.debug.harRetentionCount` 调试设置，可在 `globalStorage/har/` 中记录 HTTP 请求与响应（HAR 1.2 格式），便于排查兼容性与网关问题。默认关闭，FIM/NES 补全、Gist 同步、CLI OAuth 刷新等敏感或高频请求默认跳过录制；敏感请求头、URL 查询参数及重定向 URL 中的凭据会自动脱敏。支持按时间间隔自动轮换并强制删除 2 小时前的旧文件，避免单个 HAR 文件无限增长。

### 模型与提供商配置

- **[变更] thinking 配置支持 effort 格式**：Anthropic 请求的 thinking 配置新增 `effort-none` 等 effort 形式支持，同步优化多模型定价与上下文阈值配置。
- **[变更] 上下文窗口与 Token 限配置优化**：内置提供商模型配置的 `maxInputTokens`/`maxOutputTokens` 上限调优，提升长上下文场景兼容性（[#269](https://github.com/VicBilibily/GCMP/issues/269)）。
- **[变更] Codex 模型列表仅使用 OAuth 凭证**：Codex 远端模型列表拉取移除手动 API Key 回退，统一使用 Codex CLI OAuth 凭证；无有效凭证时回退为内置预置模型列表。
- **[变更] 腾讯云付费模型与 DeepSeek 专用密钥配置移除**：腾讯云 TokenHub 渠道的付费模型和 DeepSeek 专用密钥配置已废弃，统一使用 TokenHub / Token Plan 密钥接入。

### 架构清理

- **[变更] 移除 Gemini SSE 实验性支持**：移除 `geminiHandler`/`geminiConverter`/`geminiType` 等实验性模块（约 2300 行）。

---

### Token Pricing & Cost Estimation

- **[Added] Token pricing & client cost estimation**: Supports configuring model pricing for input, output, cache-read, and cache-write tokens through built-in model configs and `gcmp.providerOverrides.<provider>.models[].tokenPricing` / `gcmp.compatibleModels[].tokenPricing`, with different prices applied by peak/off-peak tiers, `serviceTier`, and `contextSizeMin`. Estimated costs are shown inline below token counts across the status bar, details view, and multi-day trend view. Added `formatCostBreakdownLog` output for personal reference and verification.
- **[Added] Dual-currency cost display**: Pricing configs now support listing both USD and RMB, marked by each model's native settlement currency; costs are displayed in dual currencies across the status bar (in Chinese locale), details view, sidebar date list and session records, and multi-day trend view, with a new USD/RMB currency switch view.
- **[Added] Multi-day cost view**: Added cost trend line chart and cost card summary to the multi-day trend page; optimized token and cost formatting utilities.
- **[Added] Incremental token estimation**: Based on the previous request's actual API usage, eliminating cumulative estimation errors in long contexts.
- **[Changed] Pricing configuration structure optimized**: `pricing` now supports both object form and array shorthand, allowing direct expression of input, output, cache-read, and cache-write prices while remaining compatible with existing object configs.
- **[Changed] Unified context threshold tiers**: Context pricing thresholds are now uniformly determined by actual API input tokens (including cache).

### Multi-Window Cross-Instance Coordination

- **[Added] Cross-instance state sync**: New Leader/Follower inter-instance communication module that broadcasts events via local IPC across VS Code windows for status bar, live metrics, config changes, and API key changes, with automatic fallback to file-system polling when IPC is unavailable; supports leader resignation notification with next-leader nomination for seamless primary instance switching. The Leader instance serializes stats writes and handles Follower `statsRefreshRequested` delegations to prevent concurrent overwrites, with a per-minute periodic fallback refresh for today's stats; expired data cleanup is performed solely by the Leader, and the status bar can display leader/follower role badges.
- **[Added] Cross-instance single-point CLI credential refresh**: With multiple windows, the Leader instance uniformly performs CLI OAuth token refreshes and atomically writes credential files; Followers delegate refreshes via the inter-instance bus and wait for receipts. After a delegation timeout, credentials are re-read and the leader heartbeat is checked, falling back to local refresh only when the leader is unreachable — preventing concurrent refreshes from invalidating single-rotation refresh tokens. The ChatGPT status bar usage query now uses this channel.

### Status Bar & Usage Display

- **[Added] Kimi Top-up wallet query**: Balance query and status bar display for Kimi membership plan top-up wallets, showing credit balance and expiration time.
- **[Added] ClinePass usage status bar**: Displays ClinePass plan cycle remaining usage, reset time, and total utilization in the status bar.
- **[Added] Robust output-speed statistics & reset countdown**: Real-time metrics such as output speed now use robust statistics (MAD-weighted mean) to exclude outliers; the status bar usage table adds a plan reset countdown column.
- **[Changed] Simplified context status bar**: A pie-chart icon intuitively reflects the current session's context window usage ratio (0/8 ~ 8/8); hover to view model name, usage percentage, token count, and request source type; removed detailed category breakdown and status caching.
- **[Changed] Inline cost display in token cells**: Estimated costs are displayed inline below token counts in the status bar, provider stats table, and recent request records; removed standalone cost column to save horizontal space.
- **[Changed] Status bar table column restructure**: Merged the tokens and cost columns in the daily statistics popup into a simplified "Input(+Cache)+Output=Consumed" header; cache hit and input token costs are shown separately; also adjusted token input/output formatting and removed redundant formatting utilities.
- **[Changed] Unified delayed status bar refresh**: All provider model requests now trigger a delayed `TokenUsageStatusBar.triggerDelayedUpdate` refresh after completion, reducing frequent I/O from high-frequency requests.

### Web Search & Native Tools

- **[Added] Native tools config**: Added `nativeTools` config to inject built-in tools (e.g. `web_search`, `web_extractor`) into the OpenAI Responses API; stacked with `webSearchTool` and takes precedence on conflict; only effective when `sdkMode=openai-responses`, while `anthropic` mode only picks the `web_search` entry. Model editor adds the corresponding JSON config field with live validation.
- **[Added] Web search tool**: `webSearchTool` extended from boolean to object config (`maxUses`/`allowedDomains`/`blockedDomains`/`userLocation`); added native `web_search` tool injection and `url_citation`/`web_search_call` event handling under `openai-responses` mode; model editor adds `webSearchToolConfig` JSON field with live validation. Enabled web search by default for Codex and Volcengine GLM models.

### Retry & Error Handling

- **[Added] Retry classifier**: Added retry conditions for Codex `rate_limits` and Responses API `snapshot_bootstrap` scenarios, covering rate-limit and snapshot bootstrap failure cases.
- **[Fixed] Permanent errors no longer misclassified as retryable**: Fixed permanent errors — daily/monthly hard quota exhaustion, billing or plan limits, requests exceeding model context limits — being misclassified as rate limits and retried repeatedly; unlimited retry mode (`maxAttempts=-1`) now has a 30-minute total elapsed time safeguard.
- **[Fixed] OpenAI streaming keepalive heartbeat filtering**: Fixed gateway keepalive heartbeat events arriving before `response.created` and crashing the Responses SDK stream.

### Debugging Observability

- **[Added] HAR request capture**: Added `gcmp.debug.captureHar` and `gcmp.debug.harRetentionCount` debug settings to record HTTP requests and responses (HAR 1.2 format) under `globalStorage/har/`, making it easier to diagnose compatibility and gateway issues. Disabled by default; FIM/NES completions, Gist sync, and CLI OAuth refresh requests skip capture by default; credentials in sensitive headers, URL query parameters, and redirect URLs are automatically redacted. Supports time-interval-based auto-rotation with forced deletion of files older than 2 hours, preventing unbounded HAR file growth.

### Model & Provider Configuration

- **[Changed] Thinking config supports effort format**: Anthropic request thinking config now supports effort forms such as `effort-none`; also optimized pricing and context threshold configs for multiple models.
- **[Changed] Context window & token limit config optimized**: Bumped `maxInputTokens`/`maxOutputTokens` limits for built-in provider model configs to improve long-context compatibility ([#269](https://github.com/VicBilibily/GCMP/issues/269)).
- **[Changed] Codex model list uses OAuth credentials only**: Removed the manual API key fallback when fetching the remote Codex model list, unified to Codex CLI OAuth credentials; falls back to bundled preset models when no valid credential exists.
- **[Changed] Removed Tencent paid models & DeepSeek dedicated key config**: Deprecated Tencent Cloud TokenHub paid models and DeepSeek dedicated API key config; unified to TokenHub / Token Plan key access.

### Architecture Cleanup

- **[Changed] Removed Gemini SSE experimental support**: Removed `geminiHandler`/`geminiConverter`/`geminiType` and other experimental modules (~2300 lines).

## 历史版本（仅保留功能日志）

### 0.25.0 - 0.25.44 (2026-06-21 - 2026-07-17)

- **API Key 跨设备同步（GitHub Gist）**：新增 `gcmp.sync.configure` 命令，通过 GitHub Gist 加密同步 API Key；VS Code 内置 GitHub 认证，AES-256-GCM 加密、scrypt 派生密钥
- **视觉分析工具集**：新增 7 个视觉分析工具（`#gcmpUiToArtifact`、`#gcmpExtractTextFromScreenshot`、`#gcmpDiagnoseErrorScreenshot`、`#gcmpUnderstandTechnicalDiagram`、`#gcmpAnalyzeDataVisualization`、`#gcmpUiDiffCheck`、`#gcmpAnalyzeImage`），统一由 `gcmp.vision.model` 配置的多模态模型驱动，支持 GitHub Copilot 原生视觉模型
- **辅助工具模型设置面板**：新增 `GCMP: 设置辅助工具模型` 命令与可视化面板，统一配置 Commit / Vision / Utility / Copilot Agent 模型
- **请求来源分类（requestKind）**：新增请求分类器，区分主 Agent、终端命令、代码解释、搜索子 Agent 等请求类型，并据此控制子请求思考模式
- **重试机制强化**：新增提供商级重试配置覆盖（`gcmp.providerOverrides` 的 `retry` 配置，支持子 provider 独立策略）、502/503/504 服务端错误自动退避、重试状态栏进度提示、`maxAttempts` 上限放宽与无限重试（`-1`）模式
- **editTools 能力声明**：模型 `capabilities` 新增 `editTools` 字段，可声明模型偏好的编辑工具（`find-replace` / `multi-find-replace` / `code-rewrite` / `apply-patch`）
- **Compatible 提供商余额查询配置化**：支持通过 `gcmp.providerOverrides` 的 `usage` 字段声明式配置余额查询（JSON 路径提取、加减运算、成功条件判断）
- **FIM / NES 熔断器**：补全请求新增熔断器机制，连续失败达阈值自动暂停，冷却后半开探测恢复；修复编辑器失焦后仍持续请求与 `onDidChange` 自激请求风暴问题
- **新提供商**：LongCat（Anthropic 模式 Agentic 模型）、ClinePass（聚合平台）、讯飞星辰（Coding Plan / Token Plan 双套餐）、Grok（xAI 编程模型）
- **套餐接入扩展**：百度千帆 Token Plan 个人版/企业版、腾讯云 Token Plan 企业版、Codex 动态拉取可用模型列表（远端失败回退本地预置）
- **VS Code 1.129+ 兼容适配**：修复 stable 构建下 `languageModelSystem` / `chatProvider` / `contribLanguageModelToolSets` proposal 引发的提交消息生成、Vision 工具与提供商注册失败问题

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
