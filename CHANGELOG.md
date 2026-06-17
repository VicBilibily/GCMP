# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.24.13] - 2026-06-17

### 新增

- **阿里云百炼 GLM-5.2 (TokenPlan)**：Token Plan 团队版新增 **GLM-5.2** 模型
- **OpenCode GLM-5.2 (Go)**：OpenCode Go 套餐新增 **GLM-5.2** 模型

---

### Added

- **DashScope GLM-5.2 (TokenPlan)**: Added **GLM-5.2** model to Token Plan team edition
- **OpenCode GLM-5.2 (Go)**: Added **GLM-5.2** model to OpenCode Go plan

## [0.24.12] - 2026-06-17

### 新增

- **智谱AI GLM-5.2 (PayGo)**：新增 **GLM-5.2** 按量计费模型——支持 1M 上下文窗口，三级推理强度控制（`high`/`max`/`none`），最大输出 128K tokens
- **火山方舟 GLM-5.2**：Coding Plan 和 Agent Plan 新增 **GLM-5.2** 模型
- **腾讯云 TokenHub 模型扩展**：TokenHub 新增 **GLM-5.2** 和 **Kimi-K2.7-Code** 模型

---

### Added

- **ZhipuAI GLM-5.2 (PayGo)**: Added **GLM-5.2** pay-as-you-go model — 1M context window, three-tier reasoning effort control (`high`/`max`/`none`), max 128K output tokens
- **Volcengine GLM-5.2**: Added **GLM-5.2** to Coding Plan and Agent Plan
- **Tencent TokenHub model expansion**: Added **GLM-5.2** and **Kimi-K2.7-Code** to TokenHub

## [0.24.10] - 2026-06-16

### 新增

- **阶跃星辰（StepFun）提供商**：[#232](https://github.com/VicBilibily/GCMP/issues/232) 新增阶跃星辰开源大模型系列，内置 Step Reasoning 推理模式及 `#stepfunWebSearch` MCP 联网搜索工具
- **Kimi K2.7 Code 高速模型**：MoonshotAI 新增 **Kimi K2.7 Code** 高速版本模型
- **蚂蚁百灵（Ant Ling）提供商**：新增蚂蚁集团开源 MoE 架构大语言模型家族，采用 Anthropic 模式接入，预置 **Ling-2.6-1T**（旗舰）、**Ling-2.6-flash**（高性价比）、**Ring-2.6-1T**（深度推理）三个模型
- **API 模型元数据更新**：跟进 VS Code API 变更，模型列表启用 `isBYOK` 标识，移除已废弃的 `category` 字段

### 修复

- **OpenCode SSE 流式模式**：为 OpenCode 的 SSE 请求添加请求级跟踪标识头

### 移除

- **Gemini CLI 提供商**：移除基于 CLI 认证的 Gemini 提供商支持

---

### Added

- **StepFun provider**: [#232](https://github.com/VicBilibily/GCMP/issues/232) Added StepFun (阶跃星辰) open-source LLM series with built-in Step Reasoning mode and `#stepfunWebSearch` MCP web search tool
- **Kimi K2.7 Code HighSpeed model**: MoonshotAI added **Kimi K2.7 Code** high-speed model
- **Ant Ling provider**: Added Ant Group's open-source MoE-architecture LLM family via Anthropic mode, with **Ling-2.6-1T** (flagship), **Ling-2.6-flash** (cost-effective), and **Ring-2.6-1T** (deep reasoning) models
- **API model metadata update**: Followed VS Code API changes, enabled `isBYOK` flag on model list, removed deprecated `category` field

### Fixed

- **OpenCode SSE streaming**: Added request-level tracing headers for OpenCode SSE requests

### Removed

- **Gemini CLI provider**: Removed CLI-based auth Gemini provider support

## [0.24.9] - 2026-06-14

### 新增

- **Charm Hyper 提供商**：[#218](https://github.com/VicBilibily/GCMP/pull/218) 新增 Charm Hyper 提供商（`https://hyper.charm.land/`），预置 DeepSeek-V4、Qwen3.6/3.7、GLM-5/5.1、Kimi-K2.5/2.6、MiniMax-M2.7 等 13 个模型
- **Anthropic serviceTier 支持**：`serviceTier` 配置扩展至 `anthropic` 模式；MiniMax-M3 PayGo 新增 `priority` 服务等级

---

### Added

- **Charm Hyper provider**: [#218](https://github.com/VicBilibily/GCMP/pull/218) Added Charm Hyper provider (`https://hyper.charm.land/`) with 13 preset models including DeepSeek-V4, Qwen3.6/3.7, GLM-5/5.1, Kimi-K2.5/2.6, MiniMax-M2.7
- **Anthropic serviceTier support**: Extended `serviceTier` config to `anthropic` sdkMode; MiniMax-M3 PayGo adds `priority` service tier

## [0.24.8] - 2026-06-13

### 新增

- **GLM-5.2 推理强度分级控制**：`glm-5.2` 思考模式从二值开关升级为三级推理强度（`high`/`max`/`none`）

---

### Added

- **GLM-5.2 reasoning effort control**: Upgraded `glm-5.2` thinking from binary toggle to three-tier reasoning effort (`high`/`max`/`none`)

## [0.24.7] - 2026-06-13

### 新增

- **智谱 GLM-5.2 模型**：智谱AI 编程套餐新增 `glm-5.2` 模型——基于 Anthropic API 兼容协议，定位 Opus 级旗舰，擅长复杂推理与大型工程任务：
    - 支持 1M 上下文窗口（可动态切换至 600K / 400K / 200K）
    - 最大输出 128K tokens

---

### Added

- **Zhipu GLM-5.2 model**: Added `glm-5.2` model to ZhipuAI Coding Plan — uses Anthropic API protocol, positioned as Opus-class flagship for complex reasoning and large-scale engineering tasks:
    - 1M context window (dynamically switchable to 600K / 400K / 200K)
    - Max 128K output tokens

## [0.24.6] - 2026-06-12

### 新增

- **Kimi K2.7 Code 模型**：新增 `kimi-k2.7-code` 模型到 MoonshotAI 提供商——基于 Anthropic API 兼容协议，仅支持思考模式，适用于长上下文编程任务
- **自定义 modelsEndpoint 配置**：[#227](https://github.com/VicBilibily/GCMP/issues/227) Compatible Provider 新增 `modelsEndpoint` 字段，允许为"获取模型"功能指定独立端点（相对路径或完整 URL），配合新增 `endpoint` 字段实现聊天与模型发现双端点分离

### 修复

- **CLI 认证凭证过期判定**：[#230](https://github.com/VicBilibily/GCMP/issues/230) 优化 Codex/Gemini/Grok CLI 认证流程：
    - 增加基于文件 mtime 的内存缓存，跨终端凭证更新自动检测并重新加载
    - 修复远程 SSH/Dev Container 环境下凭证获取超时导致的请求错误
    - 过期判断下沉至各 CLI 子类，Codex 使用 1h 缓冲，Gemini/Grok 使用 5min 缓冲

---

### Added

- **Kimi K2.7 Code model**: Added `kimi-k2.7-code` model to MoonshotAI provider — uses Anthropic API protocol, thinking mode only, for long-context coding tasks
- **Custom modelsEndpoint config**: [#227](https://github.com/VicBilibily/GCMP/issues/227) Added `modelsEndpoint` field to Compatible Provider, allowing a dedicated endpoint for "Fetch Models" (relative path or full URL), paired with the new `endpoint` field for chat/discovery dual-endpoint separation

### Fixed

- **CLI auth credential expiry handling**: [#230](https://github.com/VicBilibily/GCMP/issues/230) Improved Codex/Gemini/Grok CLI authentication flow:
    - Added file mtime-based in-memory caching, auto-detecting cross-terminal credential updates
    - Fixed credential timeout errors in remote SSH/Dev Container environments
    - Expiry check delegated to each CLI subclass: Codex uses 1h buffer, Gemini/Grok use 5min buffer

## [0.24.5] - 2026-06-11

### 更新

- **恢复 chatProvider API 提案**：重新启用 `package.json` 中的 `chatProvider` API 提案声明——部分 chatProvider 特性仍处于提案阶段，尚未完全稳定化，移除后会导致这些特性不可用

---

### Updated

- **Re-enabled chatProvider API proposal**: Re-added `chatProvider` API proposal declaration in `package.json` — some chatProvider features remain in proposal stage and are not yet fully stabilized; removing the declaration would break these features

## [0.24.4] - 2026-06-11

### 新增

- **Grok Composer 2.5 (fast) 模型**：[#219](https://github.com/VicBilibily/GCMP/issues/219) 为 Grok 提供商添加 Composer 2.5 (fast) 模型，同时调整输入 token 上限以避免实际上下文超限
- **OpenRouter 网关 reasoning 字段兼容**：[#221](https://github.com/VicBilibily/GCMP/issues/221) 通过 Compatible Provider 接入 OpenRouter 的推理模型（如 `deepseek/deepseek-v4-pro`）时，SSE 响应中的 `delta.reasoning` / `delta.reasoning_details` 字段现可正确解析并展示流式思考内容；`reasoning_details` 以 fallback 方式使用，避免与主字段重复

### 更新

- ~~**移除已稳定的 chatProvider API 提案配置**：[#223](https://github.com/VicBilibily/GCMP/issues/223) 移除 `package.json` 中冗余的 `enabledApiProposals` 声明~~

---

### Added

- **Grok Composer 2.5 (fast) model**: [#219](https://github.com/VicBilibily/GCMP/issues/219) Added Composer 2.5 (fast) model to Grok provider; adjusted input token limits to prevent context overflow
- **OpenRouter gateway reasoning field support**: [#221](https://github.com/VicBilibily/GCMP/issues/221) When accessing OpenRouter reasoning models (e.g., `deepseek/deepseek-v4-pro`) via Compatible Provider, the `delta.reasoning` / `delta.reasoning_details` fields in SSE responses are now correctly parsed and displayed as streaming thinking content; `reasoning_details` is used as a fallback to avoid duplication with the primary field

### Updated

- ~~**Removed stabilized chatProvider API proposal config**: [#223](https://github.com/VicBilibily/GCMP/issues/223) Removed redundant `enabledApiProposals` from `package.json`~~

## [0.24.3] - 2026-06-10

### 新增

- **多日消耗分析视图**：用量面板新增「多日分析」标签页，支持跨日期趋势统计与可视化——包含日期范围选择器、摘要卡片、趋势折线图以及按提供商/模型的消耗排名

### 更新

- **OpenCode 流式模式切换**：[#217](https://github.com/VicBilibily/GCMP/issues/217) OpenCode Go 与 Zen 套餐中的 OpenAI 兼容模型从 `openai` 切换为 `openai-sse` 流式模式，改善流式响应兼容性

---

### Added

- **Multi-day usage analysis view**: Usage panel now includes a "Multi-Day Analysis" tab with cross-date trend statistics and visualization — featuring date range picker, summary cards, trend line chart, and provider/model consumption ranking

### Updated

- **OpenCode streaming mode switch**: [#217](https://github.com/VicBilibily/GCMP/issues/217) OpenAI-compatible models under OpenCode Go and Zen plans switched from `openai` to `openai-sse` streaming mode for better streaming compatibility

## [0.24.2] - 2026-06-08

### 新增

- **系统代理自动识别**：新增 Windows Registry 与 macOS `scutil` 系统代理检测，无显式代理配置时自动沿用系统设置 (`EnvHttpProxyAgent`)；⚠️ 不支持 PAC (Proxy Auto-Config)，遇到时将被忽略
- **`cache_control` 过滤**：工具结果序列化时跳过 VS Code 内部 `cache_control` 数据片段

### 更新

- **代理解析层级优化**：`resolveProxyForModel()` 引入 `noproxy` 断链语义——当模型/提供商/全局任一层显式设为 `noproxy` 时，停止向下回退并直接绕过代理
- **火山引擎模型清单**：Coding Plan 与 Agent Plan 新增 **MiniMax-M3** 模型

---

### Added

- **Automatic system proxy detection**: Added Windows Registry and macOS `scutil` system proxy detection; falls back to system settings via `EnvHttpProxyAgent` when no explicit proxy is configured; ⚠️ PAC (Proxy Auto-Config) is not supported and will be ignored
- **`cache_control` filtering**: Skip VS Code internal `cache_control` data parts during tool result serialization

### Updated

- **Proxy resolution chain optimization**: `resolveProxyForModel()` now short-circuits on `noproxy` — if any layer (model/provider/global) is explicitly set to `noproxy`, fallback stops and the request bypasses all proxies
- **Volcengine model list**: Added **MiniMax-M3** to Coding Plan and Agent Plan

## [0.24.1] - 2026-06-06

### 新增

- **重试开关**：新增 `gcmp.retry.enabled`（boolean，默认 `true`），提供更直观的重试控制方式。关闭后请求失败将直接停止，不再重试

---

### Added

- **Retry toggle**: Added `gcmp.retry.enabled` (boolean, default `true`) for a more intuitive retry control. When disabled, request failures stop immediately without retrying

## [0.24.0] - 2026-06-06

### 新增

- **全局代理设置**：新增 `gcmp.proxy`，可为扩展内全部网络请求统一配置默认代理；支持带认证的代理 URL，日志会自动脱敏凭据
- **系统证书开关**：新增 `gcmp.tls.useSystemCertificates`，可将操作系统信任的根证书追加到 Node.js 默认 CA 列表，缓解企业代理、内网网关和本地自签根证书导致的 TLS 校验失败
- **代理覆盖层级扩展**：`gcmp.providerOverrides` 与 `gcmp.compatibleModels` 现支持 `proxy` 字段，可分别配置提供商级与模型级专用代理
- **代理链路统一**：聊天请求、FIM / NES 补全、Compatible Provider 获取模型、联网搜索、图片理解、状态栏余额/用量查询、CLI OAuth 刷新以及 MCP 客户端现统一接入代理感知请求链路

### 更新

- **运行环境升级**：将扩展运行基线升级至 Node.js `22.22.3`，并同步升级 `@vscode/chat-lib` 至 `0.47.0`

---

### Added

- **Global proxy setting**: Added `gcmp.proxy` to configure a default proxy for all extension network requests; authenticated proxy URLs are supported and credentials are automatically redacted in logs
- **System certificate toggle**: Added `gcmp.tls.useSystemCertificates` to append operating-system trusted root certificates to Node.js' default CA list, reducing TLS validation failures behind enterprise proxies, internal gateways, or locally installed private root CAs
- **Expanded proxy override layers**: `gcmp.providerOverrides` and `gcmp.compatibleModels` now support the `proxy` field for provider-level and model-level dedicated proxy settings
- **Unified proxy pipeline**: Chat requests, FIM / NES completions, Compatible Provider model discovery, web search, image understanding, status-bar quota/balance queries, CLI OAuth refresh flows, and MCP clients now share the same proxy-aware request pipeline

### Updated

- **Runtime baseline upgrade**: Raised the extension runtime baseline to Node.js `22.22.3` and upgraded `@vscode/chat-lib` to `0.47.0`

## [0.23.4] - 2026-06-03

### 新增

- **搜索工具条件可见性**：[#191](https://github.com/VicBilibily/GCMP/issues/191) 所有联网搜索工具（智谱AI、MiniMax、Kimi、阿里云百炼）现在仅在对应 API Key 已配置时才会出现在工具面板中；未配置时自动隐藏，防止模型误调用无效工具或引入无效上下文，降低请求失败率与额外开销
- **工具上下文管理器（ToolContextManager）**：新增统一的管理器，通过 VS Code `setContext` 维护工具可用性上下文键，并实时监听 API Key 变更事件自动更新工具可见性

---

### Added

- **Conditional search tool visibility**: All web search tools (ZhipuAI, MiniMax, Kimi, DashScope) now appear in the tool panel only when their corresponding API Key is configured; hidden otherwise to prevent the model from invoking invalid tools or introducing irrelevant context, reducing request failures and extra overhead
- **ToolContextManager**: New unified manager that maintains tool availability context keys via VS Code `setContext` and listens to API Key changes in real time to update tool visibility automatically

## [0.23.3] - 2026-06-02

### 优化

- **智能模型过滤**：提供商模型列表现在会根据已配置的 API Key 过滤，用户仅能看到密钥已配置的可用模型，减少干扰项（影响：百度千帆、阿里云百炼、MiniMax、Moonshot、腾讯云、火山引擎、小米 MiMo）
- **OpenCode 会话标识**：为 OpenCode 提供商添加会话级跟踪标识头（`x-opencode-session`、`x-opencode-request`、`x-opencode-project`），提升可观测性

---

### Improved

- **Smart model filtering**: Provider model lists now filter based on configured API keys — users only see models they can actually use, reducing clutter (affected: Baidu Qianfan, DashScope, MiniMax, Moonshot, Tencent, Volcengine, Xiaomi MiMo)
- **OpenCode session identification**: Added session-level tracing headers (`x-opencode-session`, `x-opencode-request`, `x-opencode-project`) for OpenCode provider, improving observability

## [0.23.2] - 2026-06-01

### 新增

- **OpenCode 新提供商**：新增 `gcmp.opencode` 提供商，支持 [OpenCode](https://opencode.ai/) 平台的 **Go 订阅**与 **Zen 按量付费**，覆盖 **GLM-5.1**、**Kimi-K2.6**、**DeepSeek-V4-Pro**、**MiniMax-M3** 等 20+ 模型
- **`thinkingFormat` 新增 `object-none` 模式**：支持 `object-none` 格式，仅当 `reasoningEffort` 为 `none` 时传递 `{ thinking: { type: 'disabled' } }`，适用于 DeepSeek 等特殊推理参数模型

---

### Added

- **New OpenCode provider**: Added `gcmp.opencode` provider supporting [OpenCode](https://opencode.ai/) **Go subscription** and **Zen pay-as-you-go**, covering 20+ models including **GLM-5.1**, **Kimi-K2.6**, **DeepSeek-V4-Pro**, **MiniMax-M3**
- **`thinkingFormat` adds `object-none` mode**: Only passes `{ thinking: { type: 'disabled' } }` when `reasoningEffort` is `none`, suitable for DeepSeek and similar models

## [0.23.1] - 2026-06-01

### 新增

- **MiniMax-M3 Token Plan 模型**：新增 MiniMax-M3 — 原生多模态、1M 上下文，最大输出 128K
- **MiniMax-M3 PayGo 模型**：使用标准密钥即可访问
- **MiniMax Key 自动迁移**：旧 `minimax-coding` → 新 `minimax-token`，无缝过渡

### 更新

- **Coding Plan → Token Plan 重命名**：命令名、配置项、状态栏、向导、代码注释等全量更新
- **图片桥接优化**：仅 M2 系列启用，M3+ 原生多模态无需桥接
- **状态栏改造**：百分比显示剩余量，API 端点更新为 `token_plan/remains`

---

### Added

- **MiniMax-M3 Token Plan model**: Natively multimodal, 1M context, max output 128K
- **MiniMax-M3 PayGo model**: Accessible with standard API key
- **Auto key migration**: Old `minimax-coding` → new `minimax-token`, seamless transition

### Updated

- **Coding Plan → Token Plan rebranding**: Commands, config, status bar, wizard, code comments
- **Image bridge optimization**: M2-series only; M3+ native multimodal
- **Status bar overhaul**: Percentage display, endpoint updated to `token_plan/remains`

## [0.23.0] - 2026-05-30

### 新增

- **Grok Build CLI (OAuth) 接入**：[#200](https://github.com/VicBilibily/GCMP/pull/200) 新增 `gcmp.grok` 提供商，支持通过 Grok Build OAuth 登录态访问 xAI 编程模型
- **Grok Build 0.1 模型**：新增 **grok-build-0.1** 模型（基于 `openai-responses` SDK 模式），支持工具调用与图片输入，最大输入 256K / 最大输出 131K

---

### Added

- **Grok Build CLI (OAuth) integration**: Added `gcmp.grok` provider supporting xAI programming models via Grok Build OAuth login ([#200](https://github.com/VicBilibily/GCMP/pull/200))
- **Grok Build 0.1 model**: Added **grok-build-0.1** model (via `openai-responses` SDK mode) with tool calling and image input support; max input 256K / max output 131K

## 历史版本（仅保留功能日志）

### 0.22.0 - 0.22.27 (2026-04-24 - 2026-05-30)

- **Commit 消息生成**：新增 System Role 提示词、默认优先读取暂存区并在生成后提示实际来源，同时加入 diff 过滤层与 `gcmp.commit.sensitiveFiles` 自定义敏感文件规则
- **Compatible 命名收敛**：界面与文档中的 `OpenAI / Anthropic Compatible` 统一简化为 `Compatible`
- **发布与激活链路**：支持 GitHub Release 自动提取当前版本更新日志；Copilot Chat 依赖声明与激活策略做过一轮调整，兼顾自动拉起与启动兼容性
- **国际化与展示**：新增中英双语界面自动切换、ChatGPT 用量重置倒计时、Copilot 上下文窗口 `usage` 数据回传，并将默认 `gcmp.maxTokens` 提升至 `32000`
- **统计与记录能力**：请求记录视图重构为会话分组展示；usages 日志新增 `sessionId` 追踪，并修复缓存损坏导致的激活失败与写入可靠性问题
- **兼容层与流式稳定性**：修复 OpenAI `/responses` 在缺少 `Content-Type`、`response.failed` 事件上抛异常、JSON 错误体误判 SSE 等兼容性问题，并补充 `limit exceeded` 重试识别
- **会话与缓存键稳健性**：修复 `prompt_cache_key` 过长问题，将 sessionId 统一收敛为短 UUID，并兼容历史 marker 中的旧格式
- **工具调用与推理回放**：修复工具调用参数分片去重/解析问题；重构 reasoning replay 策略，修复多轮工具调用中的推理内容丢失及提交场景下关闭思考参数冲突
- **配置与兼容性修正**：新增火山方舟 Agent Plan 多密钥管理与配置向导；移除 `gcmp.autoPrefixModelId` 开关并改为内置默认行为；修复 VS Code 1.120+ 第三方模型不可见、模型 ID 含中文字符解析失败、CLI 认证重复输出日志等问题
- **提供商配置清理**：移除 Moonshot 配置中的 `customHeader`，统一部分计费展示文案为 `PayGo`

### 0.21.0 - 0.21.20 (2026-03-27 - 2026-04-23)

- **百度千帆**：新增百度千帆大模型平台提供商支持
- **腾讯云**：新增腾讯云大模型服务平台 TokenHub 按量付费模型接入
- **Xiaomi MIMO**：新增 Token Plan 套餐接入与专用 API Key 配置
- **联网搜索工具**：新增 `#kimiWebSearch`、`#bailianWebSearch` 联网搜索工具支持
- **模型配置能力**：新增模型级 `thinking`、`reasoningEffort` 选项，允许手动调整模型思考模式及思考强度
- **请求重试机制**：统一由通用 Provider 处理自动重试，新增 `gcmp.retry.maxAttempts` 配置项
- **移除**：移除 Qwen Code CLI、iFlow CLI 认证提供商

### 0.20.0 - 0.20.11 (2026-03-05 - 2026-03-23)

- **Codex CLI 认证支持**：新增 OpenAI Codex (Codex CLI) 提供商支持
- **腾讯云**：新增提供商支持，包含混元模型、Coding Plan 编程套餐、DeepSeek 接入及多密钥管理
- **Xiaomi MIMO**：新增提供商支持，包含 MiMo-V2 系列模型
- **模型 Family 配置**：新增模型级别的 `family` 配置项
- **临时兼容配置项**：新增 `gcmp.autoPrefixModelId` 配置项，适配 VS Code 1.111.0 模型选择器

### 0.19.0 - 0.19.17 (2026-02-12 - 2026-02-28)

- **功能优化**：重构 Token 统计缓存机制、优化状态栏统一显示剩余百分比、API Key 输入体验优化、Anthropic cache_control 兼容性改进

### 0.18.0 - 0.18.30 (2026-01-23 - 2026-02-11)

- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
- **Token 统计**：新增完整的 Token 消耗统计系统，包括平均输出速度、首 Token 延迟、小时统计图表等可视化功能
- **MistralAI**：新增 MistralAI 提供商支持，支持 Codestral 系列模型 FIM/NES 代码补全功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格
- **阿里云百炼**：新增 Coding Plan 套餐专属模型接入

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **CLI 认证支持**：新增 CLI 工具认证模式，支持 Qwen Code CLI、Gemini CLI 进行 OAuth 认证
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
