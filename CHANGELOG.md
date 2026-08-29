# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.27.9] - 2026-08-29

### 新增

- **新增 CommandCode 提供商**：接入 [CommandCode](https://commandcode.ai/) [GOAT Plan](https://commandcode.ai/docs/plans/goat) 套餐模型，统一使用 OpenAI 兼容端点，支持 `gcmp.commandcode.setApiKey` 密钥管理。
- **CommandCode 用量查询**：状态栏与 API Key 管理面板支持余额与限频查询，无窗口限额的密钥（如 Provider plan）自动退化为纯余额展示。

### 变更

- **Anthropic 兼容端点优化**：`sdkMode=anthropic` 时若 baseUrl 以 `/v1` 结尾自动去除，避免请求路径重复。

---

### Added

- **New CommandCode provider**: Integrated the [CommandCode](https://commandcode.ai/) [GOAT Plan](https://commandcode.ai/docs/plans/goat) models via the OpenAI-compatible endpoint, with API key management through `gcmp.commandcode.setApiKey`.
- **CommandCode usage tracking**: The status bar and the API key management panel now support balance and rate-limit queries; keys without window limits (e.g. Provider plan) fall back to balance-only display.

### Changed

- **Anthropic endpoint compatibility**: When `sdkMode=anthropic`, a baseUrl ending in `/v1` is now trimmed automatically to avoid duplicated request paths.

---

## [0.27.8] - 2026-08-28

### 新增

- **新增 `effort-only` thinkingFormat**：模型可配置该格式，忽略 thinking 开关并将 reasoningEffort 原样透传（不做值映射），对所有 SDK 模式生效；已适配 OpenAI（含 Responses）与 Anthropic 处理逻辑。
- **OpenCode Go 新增 Muse Spark 1.2 Contributor**：1M 上下文，支持视觉输入与函数调用，采用 `effort-only` 思考格式（reasoningEffort 支持 high / xhigh / medium / low / minimal）。[#386](https://github.com/VicBilibily/GCMP/issues/386)
- **腾讯云 TokenHub 新增 Hy4 Preview**：1024k 上下文、960k 最大输入，支持深度思考与函数调用。

---

### Added

- **New `effort-only` thinkingFormat**: Models can opt into this format to ignore the thinking toggle and pass `reasoningEffort` through as-is (no value mapping), effective for all SDK modes; adapted for OpenAI (including Responses) and Anthropic handlers.
- **Muse Spark 1.2 Contributor on OpenCode Go**: 1M context with vision input and function calling, using the `effort-only` thinking format (reasoningEffort: high/xhigh/medium/low/minimal). [#386](https://github.com/VicBilibily/GCMP/issues/386)
- **Hy4 Preview on Tencent Cloud TokenHub**: 1024k context, 960k max input, with deep thinking and function calling support.

---

## [0.27.7] - 2026-08-27

### 变更

- **移除 DashScope Coding Plan 接入**：DashScope 移除 `glm-5-coding-plan`、`kimi-k2.5-coding-plan`、`qwen3.6-plus-coding-plan`、`qwen3.7-plus-coding-plan` 等 Coding Plan 套餐模型与密钥配置。
- **移除百度千帆 Coding Plan 接入**：百度千帆移除 `deepseek-v3.2-coding-plan`、`deepseek-v4-flash-coding-plan`、`deepseek-v4-pro-coding-plan`、`glm-5-coding-plan`、`glm-5.1-coding-plan`、`kimi-k2.5-coding-plan` 等 Coding Plan 套餐模型与密钥配置。
- **DashScope 模型更新**：新增 `qwen3.8-flash`（含 Token Plan 团队版 / 个人版 / PayGo）。

---

### Changed

- **Removed DashScope Coding Plan support**: Dropped Coding Plan models (`glm-5-coding-plan`, `kimi-k2.5-coding-plan`, `qwen3.6-plus-coding-plan`, `qwen3.7-plus-coding-plan`) and key configuration from DashScope.
- **Removed Baidu Qianfan Coding Plan support**: Dropped Coding Plan models (`deepseek-v3.2-coding-plan`, `deepseek-v4-flash-coding-plan`, `deepseek-v4-pro-coding-plan`, `glm-5-coding-plan`, `glm-5.1-coding-plan`, `kimi-k2.5-coding-plan`) and key configuration from Baidu.
- **DashScope model updates**: Added `qwen3.8-flash` (Token Plan Team / Personal / PayGo).

---

## [0.27.6] - 2026-08-26

### 变更

- **新增智谱 GLM-5.3-Flash**：GLM-5 系列首个原生多模态模型，支持 1M 上下文、图片/视频/文件视觉输入与函数调用，同时接入 CodingPlan、OpenCode Go 套餐，并支持 PayGo 按量计费。
- **清理下架旧模型**：智谱移除 `glm-5v-turbo`、`glm-5-turbo`、`glm-4.7`、`glm-4.6v` 及对应 PayGo 变体；OpenCode 移除 `glm-5.1`。

---

### Changed

- **Added Zhipu GLM-5.3-Flash**: GLM-5 series' first natively multimodal model with 1M context, image/video/file vision input, and function calling, now available via CodingPlan and OpenCode Go subscriptions, with PayGo pay-as-you-go billing.
- **Removed legacy models**: Dropped `glm-5v-turbo`, `glm-5-turbo`, `glm-4.7`, `glm-4.6v` (and their PayGo variants) from Zhipu; dropped `glm-5.1` from OpenCode.

---

## [0.27.5] - 2026-08-26

### 变更

- **ChatGPT 席位名称对接 Codex TUI**：`team` / `self_serve_business_usage_based` 显示为 Business，`self_serve_business_prolite` 显示为 Business Premium，`business` / `enterprise` / `enterprise_cbp_usage_based` 显示为 Enterprise，`enterprise_cbp_automation` 显示为 Enterprise (Automation)，教育系席位统一为 Edu / Edu Plus / Edu Pro。

---

### Changed

- **ChatGPT seat names aligned with Codex TUI**: `team` and `self_serve_business_usage_based` display as Business, `self_serve_business_prolite` as Business Premium, `business`/`enterprise`/`enterprise_cbp_usage_based` as Enterprise, `enterprise_cbp_automation` as Enterprise (Automation), and education plans as Edu/Edu Plus/Edu Pro.

## [0.27.4] - 2026-08-25

### 新增

- **OpenCode Go 新增 LongCat-2.0**：Go 套餐加入 LongCat-2.0，1M 上下文高性能 Agentic 模型。

### 变更

- **移除腾讯云 Coding Plan 接入**：删除 `glm-5-coding-plan` 模型、Coding Plan 密钥设置命令、配置向导入口与 Gist 同步标签，相关代码同步清理。

---

### Added

- **LongCat-2.0 on OpenCode Go**: Added the LongCat-2.0 model to the OpenCode Go plan with 1M context.

### Changed

- **Removed Tencent Cloud Coding Plan support**: Deleted the `glm-5-coding-plan` model, the Coding Plan API key command, wizard entry, and Gist sync label, with related code cleaned up.

## [0.27.3] - 2026-08-23

### 变更

- **DeepSeek 峰谷计费规则更新**：周末全天按低谷价收费，DeepSeek 与 OpenCode 接入点的 DeepSeek 模型峰谷 cron 改为仅工作日高峰，并补充时间匹配测试。

### 修复

- **防止 `event:keepalive` 报错**：OpenAI SSE 过滤 keepalive / `codex.rate_limits` 的 event 行改用正则匹配，容忍紧凑格式。

---

### Changed

- **DeepSeek peak/off-peak billing update**: Weekends are now all-day off-peak; DeepSeek models in DeepSeek and OpenCode endpoints only apply peak cron on weekdays, with time-matching tests added.

### Fixed

- **Prevent `event:keepalive` errors**: OpenAI SSE now filters keepalive / `codex.rate_limits` event lines via regex to tolerate compact formats.

## [0.27.2] - 2026-08-22

### 新增

- **Kimi-K3 旗舰模型**：DashScope 新增 `kimi-k3` 模型。
- **DeepSeek-V4-Flash-Vision-Exp 识图模型**：DeepSeek 与 OpenCode Go 套餐新增模型。

---

### Added

- **Kimi-K3 flagship model**: Added `kimi-k3` to DashScope.
- **DeepSeek-V4-Flash-Vision-Exp**: Added to DeepSeek and OpenCode Go plans.

## [0.27.1] - 2026-08-20

### 变更

- **站点/接入点切换上移 Provider 层**：智谱国际站、MiniMax 国际站、小米 MiMo Token Plan 接入点的 baseUrl 替换逻辑从各 SDK Handler 移至对应 Provider 的 `resolveRequestBaseUrl` 统一解析，OpenAI / Anthropic / Responses 各 SDK 模式共享同一套站点切换。

---

### Changed

- **Endpoint switching moved to the provider layer**: baseUrl replacement for the ZhipuAI international site, MiniMax international site, and Xiaomi MiMo Token Plan endpoints now resolves once in each provider's `resolveRequestBaseUrl` and is shared by all SDK modes (OpenAI / Anthropic / Responses).

## [0.27.0] - 2026-08-20

### 新增

- **API Key 管理面板**：新命令 `gcmp.configSet.manage` 打开统一面板，按提供商/槽位管理多套配置（站点 + Key + 备注），支持新增、修改、删除、激活与停用；配置可上传 Gist 备份并跨设备恢复。
- **CLI 认证并入管理面板**：Codex / Grok 的认证状态与订阅余量在面板内展示，支持打开终端登录、导入/刷新凭证；移除认证改为在文件管理器中定位凭证文件，由用户手动删除。
- **跨实例多维度限流**：provider 配置新增 `limit` 字段，支持 rpm/rps/tpm/parallel 四个维度，可按 provider、子 provider（`limit.xxx`）与模型级逐级覆盖；多个 VS Code 窗口共享 Leader 权威限流桶，维度以 Leader 本机配置为准（配置修改即时生效），超限时 FIFO 排队或匀速延迟（pacing），Leader 不可用时自动降级为单窗口本地桶并每 60 秒探测恢复；窗口实例断线时 Leader 自动回收其排队项与持有的配额，避免幽灵占用阻塞队列。
- **限流任期机制**：限流桶引入权威任期（Leader ID + 选举时间），Leader 切换时主动清理旧任期的排队请求与流式状态并支持客户端自动重试（连续任期变更超上限自动降级本地桶，避免选举抖动自旋），切换期间旧 Leader 在途请求的并发槽位经快照交接与短心跳续租保持计数直至释放；排队请求收到首个权威顺位确认后持续等待直至授予，IPC 断连时自动降级本地桶；实例断线自动清理其残留的实时指标快照。

### 变更

- **配额查询下沉共享层 `src/quota`**：Codex / Grok 与配置管理面板共用 provider 额度查询与表格构建；MiniMax 状态栏额度窗口判定已与共享层对齐，Grok 响应解析保持纯逻辑模块独立并可单元测试。
- **API Key 本地变更事件**：`ApiKeyManager` 新增本实例变更通知，面板内激活/停用/编辑 Key 后状态栏即时刷新；模型列表缓存按槽位精确失效。
- **Leader 切换重连优化**：修复 Leader 切换时的重连逻辑与空限流配置下的处理问题。
- **旧版密钥同步入口合并**：状态栏 tooltip 的「管理/同步 API Key」入口移除，旧版同步界面并入 API Key 管理面板的「Gist 同步」下拉菜单，保留一个主版本供迁移（将于 0.28 移除）。

---

### Added

- **API Key management panel**: New command `gcmp.configSet.manage` opens a unified panel to manage multiple configurations per provider/slot (site + key + note), with add/edit/delete/activate/deactivate; configurations can be backed up to Gist and restored across devices.
- **CLI authentication integrated into the panel**: Codex / Grok auth status and subscription quota are shown in the panel, with terminal sign-in and credential import/refresh; removing authentication now locates the credential file in the file manager for manual deletion.
- **Cross-instance multi-dimensional rate limiting**: providers now accept a `limit` field with rpm/rps/tpm/parallel dimensions, overridable per provider, sub-provider (`limit.xxx`), and model; multiple VS Code windows share a Leader-authoritative bucket whose dimensions always follow the Leader's local configuration (config edits take effect immediately), with FIFO queuing or pacing when limits are hit, automatic fallback to a per-window local bucket when the Leader is unavailable (re-probed every 60s), and automatic reclamation of a disconnected window's queued requests and held quotas so ghost occupancy never blocks the queue.
- **Rate-limit authority terms**: buckets carry an authority term (Leader ID + election time); on Leader switch, stale queued requests and streaming state are cleaned up with bounded client-side retry (repeated term changes degrade to the local bucket instead of spinning), while in-flight grants from the previous Leader keep their concurrency accounting through snapshot handoff and short-interval lease renewal until released; queued requests keep waiting once the first authoritative queue position arrives, and degrade to the local bucket if the IPC link drops; disconnecting instances have their leftover live-metric snapshots removed automatically.

### Changed

- **Quota queries moved to the shared `src/quota` layer**: Codex / Grok and the configuration panel share provider quota queries and table builders; the MiniMax status bar now follows the same quota-window rules, while Grok response parsing stays in an isolated pure module with unit tests.
- **Local API key change event**: `ApiKeyManager` now notifies the current instance; the status bar refreshes immediately after activate/deactivate/edit in the panel, and model list caches are invalidated per slot.
- **Leader switchover reconnection improvements**: Fixed reconnection logic during Leader switches and the handling of empty rate-limit configurations.
- **Legacy key sync entry merged**: the status bar tooltip's "Manage / Sync API Keys" entry was removed; the legacy sync UI now lives in the API Key management panel's "Gist Sync" dropdown and is kept for one major version for migration (removal in 0.28).

## 历史版本（仅保留功能日志）

### 0.26.0 - 0.26.39 (2026-07-19 - 2026-08-20)

- **Token 定价与客户端成本估算**：支持输入/输出/缓存读/缓存写分项定价，按峰谷时段、服务等级与上下文大小分档；预估成本内联显示在 Token 下方，支持 USD/RMB 双币种与多日成本趋势图，并基于上一轮实际用量做增量预估
- **多窗口跨实例协同（Leader / Follower）**：基于本地 IPC 广播在多 VS Code 窗口间同步状态栏、实时指标、配置与 API Key 变更，IPC 不可用时自动降级文件系统轮询
- **状态栏用量查询扩充**：新增 OpenCode Go 套餐用量、Grok 订阅额度、Charm Hyper 余额、Kimi 加油包钱包与 ClinePass 用量查询展示
- **Token 用量视图增强**：新增多日成本趋势图、活跃日期多会话实时跟踪、正式会话标题回填与压缩后会话恢复桥接、按提供商统计的缓存命中率显示，并优化视图刷新性能
- **Anthropic 提示缓存自动管理**：自动注入与清理缓存断点、统一 `cacheTtl` 配置；重试改由外层统一调度，遵循服务端 `retry-after` / `x-should-retry` 头
- **加密思维链持久化**：StatefulMarker 将加密 reasoning / redacted_thinking 跨轮次持久化，ThinkingPart 被剥离时自动恢复
- **请求重试机制强化**：新增 Codex / Responses 限流与快照引导重试判定；修复永久性错误被误判为限流反复重试；HTTP 408 等瞬时超时纳入自动重试
- **Compatible 能力增强**：自定义余额/用量查询支持乘除与常量换算；自定义模型服务等级选择
- **调试可观测**：新增 HAR 请求录制（自动脱敏、按时间轮换清理）

### 0.25.0 - 0.25.44 (2026-06-21 - 2026-07-17)

- **API Key 跨设备同步（GitHub Gist）**：新增 `gcmp.sync.configure` 命令，通过 GitHub Gist 加密同步 API Key；VS Code 内置 GitHub 认证，AES-256-GCM 加密、scrypt 派生密钥
- **视觉分析工具集**：新增 7 个视觉分析工具（`#gcmpUiToArtifact`、`#gcmpExtractTextFromScreenshot`、`#gcmpDiagnoseErrorScreenshot`、`#gcmpUnderstandTechnicalDiagram`、`#gcmpAnalyzeDataVisualization`、`#gcmpUiDiffCheck`、`#gcmpAnalyzeImage`），统一由 `gcmp.vision.model` 配置的多模态模型驱动，支持 GitHub Copilot 原生视觉模型
- **辅助工具模型设置面板**：新增 `GCMP: 设置辅助工具模型` 命令与可视化面板，统一配置 Commit / Vision / Utility / Copilot Agent 模型
- **请求来源分类（requestKind）**：新增请求分类器，区分主 Agent、终端命令、代码解释、搜索子 Agent 等请求类型，并据此控制子请求思考模式
- **重试机制强化**：新增提供商级重试配置覆盖（`gcmp.providerOverrides` 的 `retry` 配置，支持子 provider 独立策略）、502/503/504 服务端错误自动退避、重试状态栏进度提示、`maxAttempts` 上限放宽与无限重试（`-1`）模式
- **Compatible 提供商余额查询配置化**：支持通过 `gcmp.providerOverrides` 的 `usage` 字段声明式配置余额查询（JSON 路径提取、加减运算、成功条件判断）
- **FIM / NES 熔断器**：补全请求新增熔断器机制，连续失败达阈值自动暂停，冷却后半开探测恢复；修复编辑器失焦后仍持续请求与 `onDidChange` 自激请求风暴问题

### 0.23.0 - 0.24.16 (2026-05-30 - 2026-06-21)

- **Grok Build CLI (OAuth) 接入**：[#200](https://github.com/VicBilibily/GCMP/pull/200) 新增 `gcmp.grok` 提供商，支持通过 Grok Build OAuth 登录态访问 xAI 编程模型；新增 **grok-build-0.1** 模型，支持工具调用与图片输入
- **全局代理链路统一**：新增 `gcmp.proxy`、`gcmp.tls.useSystemCertificates`，扩展提供商与模型级 `proxy` 覆盖；统一聊天请求、FIM/NES、模型发现、搜索、图片理解、状态栏查询、CLI OAuth 刷新及 MCP 客户端的代理感知链路
- **系统代理自动识别**：新增 Windows Registry 与 macOS `scutil` 系统代理检测，无显式配置时自动沿用系统设置
- **多日消耗分析视图**：用量面板新增「多日分析」标签页，支持跨日期趋势统计与可视化
- **重试开关**：新增 `gcmp.retry.enabled`（默认 `true`）

### 0.22.0 - 0.22.27 (2026-04-24 - 2026-05-30)

- **Commit 消息生成**：新增 System Role 提示词、默认优先读取暂存区并在生成后提示实际来源，同时加入 diff 过滤层与 `gcmp.commit.sensitiveFiles` 自定义敏感文件规则
- **Compatible 命名收敛**：界面与文档中的 `OpenAI / Anthropic Compatible` 统一简化为 `Compatible`
- **国际化与展示**：新增中英双语界面自动切换、ChatGPT 用量重置倒计时、Copilot 上下文窗口 `usage` 数据回传

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

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **OpenAI Responses API 支持**：新增 `openai-responses` SDK 模式，支持思维链、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
