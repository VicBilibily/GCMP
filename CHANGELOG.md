# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

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

## [0.22.27] - 2026-05-30

### 新增

- **Commit diff 过滤规则**：Commit 消息生成在分析 diff 前新增过滤层，自动跳过常见敏感文件（如 `.env*`、证书/私钥文件、`.aws` / `.ssh` / `.gnupg` / `.docker` 目录）并省略 lockfile / snapshot 的大段 diff 内容，避免将无关噪音或潜在敏感内容发送给模型
- **自定义敏感文件配置**：新增 `gcmp.commit.sensitiveFiles` 设置项，支持通过简单类 glob 规则追加自定义敏感文件过滤模式

### 更新

- **Compatible Provider 命名简化**：将界面与文档中的 `OpenAI / Anthropic Compatible` 统一简化为 `Compatible`

---

### Added

- **Commit diff filtering rules**: Added a filtering layer before commit diff analysis to automatically skip common sensitive files (such as `.env*`, certificate/private key files, and files under `.aws` / `.ssh` / `.gnupg` / `.docker`) and omit large lockfile / snapshot diff bodies, preventing noisy or potentially sensitive content from being sent to the model
- **Custom sensitive file configuration**: Added the `gcmp.commit.sensitiveFiles` setting, allowing users to extend sensitive file filtering with simple glob-like patterns

### Updated

- **Compatible Provider naming simplified**: Renamed `OpenAI / Anthropic Compatible` to simply `Compatible` across UI and documentation

## [0.22.26] - 2026-05-30

### 移除

- **Codex 即将下线模型**：移除即将下线的 **GPT-5.3-Codex** 与 **GPT-5.2**

### 修复

- **CLI 认证重复加载日志**：[#199](https://github.com/VicBilibily/GCMP/pull/199) 修复 CLI 认证场景下反复输出 `Credentials loaded` 的问题

---

### Removed

- **Codex soon-to-be-retired models**: Removed the soon-to-be-retired **GPT-5.3-Codex** and **GPT-5.2** models

### Fixed

- **Repeated CLI credential loading logs**: Fixed repeated `Credentials loaded` output in CLI auth flows

## [0.22.25] - 2026-05-29

### 移除

- **小米 MiMo 下线模型**：移除 **MiMo-V2-Pro**、**MiMo-V2-Omni** 及其 Token Plan 版本，保留 **MiMo-V2.5-Pro**、**MiMo-V2.5**、**MiMo-V2-Flash**

### 修复

- **Responses API 响应识别修复**：修复 `/responses` 在缺少 `Content-Type` 时，将 JSON 错误体误判为 SSE 流而导致崩溃的问题；现在会先探测响应前缀，正确区分真实 SSE 与错误响应，并在遇到非标准 SSE / 裸 JSON 流时按异常处理，尽量读取完整错误内容后再抛出
- **重试策略补充 `limit exceeded` 场景**：在重试管理器中添加对 `limit exceeded` 错误消息的识别，使其能被正确识别为可重试的速率限制/过载场景

---

### Removed

- **Xiaomi MiMo discontinued models**: Removed **MiMo-V2-Pro**, **MiMo-V2-Omni**, and their Token Plan variants; retained **MiMo-V2.5-Pro**, **MiMo-V2.5**, **MiMo-V2-Flash**

### Fixed

- **Responses API response detection**: Fixed `/responses` misclassifying JSON error bodies as SSE streams when `Content-Type` was missing, which could crash stream processing. The response prefix is now sniffed first to distinguish genuine SSE from error responses, and non-standard SSE / raw JSON streams are now treated as errors with best-effort full error body capture before throwing
- **Retry policy `limit exceeded` coverage**: Added `limit exceeded` to the retry manager's rate-limit/overload detection so it is correctly recognized as a retriable condition

## [0.22.24] - 2026-05-29

### 新增

- **火山方舟按量计费模型**：新增 **DeepSeek-V4-Flash-260425**、**DeepSeek-V4-Pro-260425** 按量计费（PayGo）模型，使用默认 `api/v3` 端点

### 修复

- **工具调用参数重复分片处理**：修复流式响应中工具调用参数分片重复处理逻辑，避免因参数分片去重不当导致 JSON 解析失败 [#194](https://github.com/VicBilibily/GCMP/issues/194)

---

### Added

- **Volcengine PayGo models**: Added **DeepSeek-V4-Flash-260425** and **DeepSeek-V4-Pro-260425** pay-as-you-go models using the default `api/v3` endpoint

### Fixed

- **Tool call argument fragment deduplication**: Fixed tool call argument fragment handling in streaming responses to avoid JSON parsing failures caused by improper deduplication logic

## [0.22.23] - 2026-05-27

### 修复

- **OpenAI Responses API 兼容性**： 修复部分兼容 `/responses` 流式网关未返回 `Content-Type`、`response.failed` 事件未正确上抛，以及 `output` / `content` 缺失时导致的流处理异常 [#189](https://github.com/VicBilibily/GCMP/issues/189)

---

### Fixed

- **OpenAI Responses API compatibility**: Fixed stream handling issues for some compatible `/responses` gateways when `Content-Type` was missing, `response.failed` events were not surfaced correctly, or `output` / `content` fields were absent

## [0.22.22] - 2026-05-23

### 更新

- **默认最大输出 Token**：将 `gcmp.maxTokens` 默认值从 `16000` 调整为 `32000`

### 重构

- **请求记录视图界面重构**：新增会话分组视图，左侧筛选会话、右侧查看该会话的完整请求链路

---

### Updated

- **Default max output tokens**: Increased the default `gcmp.maxTokens` value from `16000` to `32000`

### Refactored

- **Request records statistics and display overhaul**: Added session grouping with filter sidebar and per-session full trace detail view

## [0.22.21] - 2026-05-22

### 新增

- **百度千帆 Coding Plan**：新增 **DeepSeek-V4-Pro** 模型

### 修复

- **GPT prompt_cache_key 超长错误**：修复 OpenAI Responses API 的 `prompt_cache_key` 因 sessionId 过长（超过 64 字符）导致请求失败的问题
- **sessionId 统一为短 UUID**：移除 anthropic 模式下的超长 sessionId 格式（`user_xxx_account__session_xxx`），统一使用短 UUID 存储与传递，各 handler 按需在 metadata 处拼接扩展格式
- **向后兼容旧 sessionId**：读取 stateful marker 中的旧 anthropic 格式 sessionId 时自动提取 UUID 部分，确保历史会话数据不受影响

---

### Added

- **Baidu Qianfan Coding Plan**: Added **DeepSeek-V4-Pro** model

### Fixed

- **GPT prompt_cache_key too long**: Fixed OpenAI Responses API error when `prompt_cache_key` exceeds 64-character limit due to lengthy sessionId
- **Unified sessionId as short UUID**: Removed the lengthy anthropic sessionId format (`user_xxx_account__session_xxx`), unified storage and transport to short UUID, with per-handler metadata formatting on demand
- **Backward compatible old sessionId**: Automatically extract UUID from legacy anthropic-format sessionId in stateful markers, ensuring existing session data continues to work

## [0.22.20] - 2026-05-22

### 新增

- **阿里云百炼新模型**：新增 **Qwen3.7-Max**、**Qwen3.6-Max-Preview** 模型
- **Token 统计按会话追踪**： usages 日志系统新增 `sessionId` 字段

---

### Added

- **AliDashScope new models**: Added **Qwen3.7-Max** and **Qwen3.6-Max-Preview** models
- **Token usage session tracking**: Added `sessionId` field to usages logging system for session-level token usage tracking

## [0.22.19] - 2026-05-20

### 新增

- **Codex 服务等级选择**：GPT-5.3-Codex、GPT-5.4、GPT-5.5 模型新增 `serviceTier` 服务等级选项（default / priority），可调节响应速度与配额倍率 [#169](https://github.com/VicBilibily/GCMP/issues/169)

---

### Added

- **Codex service tier selection**: Added `serviceTier` options (default / priority) for GPT-5.3-Codex, GPT-5.4, and GPT-5.5 models, allowing adjustment of response speed and rate multiplier

## [0.22.18] - 2026-05-19

### 新增

- **上下文窗口档位覆盖**：百度千帆、阿里云百炼、腾讯云 TokenHub、火山方舟的 DeepSeek V4 模型新增 `contextSize` 上下文窗口档位选项（1M / 600K / 400K / 256K / 192K）

### 修复

- **火山方舟 Coding Plan**：修复 Coding Plan 的 DeepSeek V4 模型错误使用了 Agent Plan API Key 的问题 [#182](https://github.com/VicBilibily/GCMP/issues/182)

---

### Added

- **Context window tier coverage**: Added `contextSize` options for DeepSeek V4 models in Baidu Qianfan, AliDashScope, Tencent TokenHub, and Volcengine (1M / 600K / 400K / 256K / 192K)

### Fixed

- **Volcengine Coding Plan**: Fixed DeepSeek V4 models under Coding Plan mistakenly using Agent Plan API Key

## [0.22.17] - 2026-05-19

### 新增

- **上下文窗口档位切换**：DeepSeek 官方与小米 MiMo 模型支持用户手动选择上下文窗口档位，通过模型配置中的 `contextSize` 字段可指定不同档位大小

### 修复

- **模型 ID 中文字符兼容**：修复 provider 或 modelId 包含中文字符时，前缀解析正则无法正确匹配的问题 [#180](https://github.com/VicBilibily/GCMP/pull/180)

---

### Added

- **Context window tier switching**: DeepSeek and Xiaomi MiMo models now allow users to manually select context window tiers via the `contextSize` field in model config

### Fixed

- **Chinese character support in model ID**: Fixed prefix parsing regex failing to match when provider or modelId contains Chinese characters

## [0.22.16] - 2026-05-18

### 新增

- **火山方舟 Coding Plan**：新增 **DeepSeek-V4-Flash**、**DeepSeek-V4-Pro** 模型

### 更新

- **火山方舟 Agent Plan**：将 **DeepSeek-V4-Flash-Beta** 与 **DeepSeek-V4-Pro-Beta** 更新为正式版 **DeepSeek-V4-Flash** 与 **DeepSeek-V4-Pro**

---

### Added

- **Volcengine Coding Plan**: Added **DeepSeek-V4-Flash** and **DeepSeek-V4-Pro** models

### Updated

- **Volcengine Agent Plan**: Updated **DeepSeek-V4-Flash-Beta** and **DeepSeek-V4-Pro-Beta** to official releases **DeepSeek-V4-Flash** and **DeepSeek-V4-Pro**

## [0.22.15] - 2026-05-16

### 新增

- **中英双语国际化**：全面支持中文/英文界面，根据 VS Code 语言环境自动切换

---

### Added

- **Chinese/English bilingual i10n**: Full support for Chinese/English UI, auto-switching based on VS Code language

## [0.22.14] - 2026-05-16

### 新增

- **Copilot 上下文窗口用量反馈**：在流式响应结束时向 Copilot 上下文窗口发送 usage DataPart（MIME type: `usage`），使 Copilot 能获取实际 prompt_tokens、completion_tokens 及缓存命中等信息

---

### Added

- **Copilot context window usage reporting**: Send usage DataPart (MIME type: `usage`) to the Copilot context window at the end of each streaming response, enabling Copilot to access actual prompt_tokens, completion_tokens, and cache hit details

## [0.22.13] - 2026-05-15

### 新增

- **Release 自动填充更新日志**：在 GitHub Release 发布时，自动从 CHANGELOG 提取当前版本内容填充 Release 正文，无需手动复制粘贴

### 恢复

- **恢复 Copilot Chat 扩展依赖声明**：重新将 `github.copilot-chat` 加入 `extensionDependencies`，确保 VS Code 在激活 GCMP 前自动加载 Copilot Chat

## [0.22.12] - 2026-05-15

### 新增

- **ChatGPT 用量重置倒计时**：在状态栏 Tooltip 的用量表格中增加倒计时列（如 `4d 13h`、`13m`、`30s`），便于直观感知额度重置时间（[#175](https://github.com/VicBilibily/GCMP/pull/175)）
- **火山方舟 Agent Plan**：新增 **DeepSeek-V4-Flash-Beta**、**DeepSeek-V4-Pro-Beta** 模型
- **阿里云百炼**：新增模型 **Qwen3.6-Flash**
    - **Token Plan**：新增模型 **Qwen3.6-Flash**、**GLM-5.1**、**Kimi-K2.6**、**Kimi-K2.5**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**

### 移除

- **`autoPrefixModelId` 配置项**：模型 ID 前缀模式（`gcmp.${provider}:::${modelId}`）已作为默认行为内置，移除 `gcmp.autoPrefixModelId` 开关及其关联代码
- **Copilot Chat 扩展依赖声明**：移除 `extensionDependencies` 中的 `github.copilot-chat` 硬依赖，改为激活时尝试拉起 Copilot Chat

## [0.22.11] - 2026-05-13

### 修复

- **MiMo 多轮工具调用推理丢失**：重构思考内容回放策略，修复 MiMo 模型在多轮工具调用场景下 `reasoning_content` 未正确传回 API 导致请求失败的问题（[#171](https://github.com/VicBilibily/GCMP/issues/171)）
    - 提取通用策略模块 `reasoningReplayPolicy`，替代原 DeepSeek-V4 硬编码逻辑
    - OpenAI 与 Anthropic 两条转换路径均已适配
- **工具调用参数解析失败**：修复 `deduplicateToolArgs` 误删单字符标点导致工具调用参数解析失败的问题（[#173](https://github.com/VicBilibily/GCMP/pull/173)）

### 优化

- **模型计费描述统一**：统一将模型名称中的"按量计费"和"按量付费"更改为 **PayGo**，涵盖智谱AI、MiniMax、快手万擎、腾讯云、百度千帆等提供商

## [0.22.10] - 2026-05-11

### 新增

- **百度千帆**：新增 **ERNIE-5.1** 按量计费模型

### 修复

- **VS Code 1.120.0 模型不显示**：修复 VS Code 1.120.0 及以上版本无法识别第三方模型的问题，补齐 `isUserSelectable` 属性声明（[#159](https://github.com/VicBilibily/GCMP/issues/159)）

## [0.22.9] - 2026-05-09

### 新增

- **百度千帆**：新增 DeepSeek-V4 系列模型
    - **Coding Plan**：**DeepSeek-V4-Flash**、**GLM-5.1**
    - **按量计费**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**

### 修复

- **请求中止残留空消息**：修复用户取消请求后，VS Code 保留的空 assistant 消息（仅含空白文本与空代码块）导致后续请求随机缓存命中暴降的问题（[#157](https://github.com/VicBilibily/GCMP/issues/157)）

## [0.22.8] - 2026-05-08

### 新增

- **火山方舟 Agent Plan**：新增 Agent Plan 套餐支持
    - **豆包模型**：**Doubao-Seed-2.0**(Code/pro/lite/mini)
    - **开源模型**：**GLM-5.1**、**MiniMax-M2.7**、**Kimi-K2.6**、**DeepSeek-V3.2**
- **火山方舟多密钥管理**：支持 Coding Plan 与 Agent Plan 独立密钥配置
- **火山方舟配置向导**：新增交互式配置向导，引导用户正确设置不同套餐的专用 API Key

### 移除

- **火山方舟**：移除即将下线的 **Doubao-Seed-1.6** 与 **DeepSeek-V3.1** 模型

## [0.22.7] - 2026-05-06

### 优化

- **Commit 默认读取策略**：提交消息生成默认入口改为优先读取暂存区，若暂存区无变更则自动回退到未提交工作树，无需手动选择
- **Commit 来源提示**：生成完成后提示信息显示实际使用的变更来源（暂存区 / 工作树）

### 更新

- **火山方舟 Doubao Seed 2.0**：Doubao-Seed-2.0-mini 与 Doubao-Seed-2.0-lite 更新为 260428 版本

## [0.22.6] - 2026-04-28

### 修复

- **火山方舟 Seed 2.0 推理强度**：修复使用 Anthropic 接口的火山模型选择 `minimal` 推理强度时，错误地将 `minimal` 传递到请求体导致 API 报错的问题；`minimal` 现在正确映射为关闭思考模式（[#149](https://github.com/VicBilibily/GCMP/issues/149)）

## [0.22.5] - 2026-04-28

### 修复

- **提交消息生成失败**：修复 DeepSeek-V4 等默认开启思考的模型在生成提交消息时报错 `thinking options type cannot be disabled when reasoning_effort is set` 的问题（[#148](https://github.com/VicBilibily/GCMP/issues/148)）
    - Anthropic SDK：提交模式下禁用思考时同步移除 `output_config`，避免参数冲突
    - OpenAI SDK：提交模式下 `thinkingFormat=object` 时同步移除 `reasoning_effort`；`thinkingFormat=boolean` 时仅当关闭选项为首项配置才传递 `reasoning_effort` 关闭思考，其余由 `enable_thinking=false` 直接关闭
    - Responses API：提交模式下无条件设置 `thinking.type=disabled`，并显式补齐 `reasoning.effort` 关闭值（`none`/`minimal`），不再依赖请求中是否已有 reasoning 字段

## [0.22.4] - 2026-04-25

### 移除

- **Moonshot**：移除 Moonshot 配置中的 `customHeader`（`HTTP-Referer`、`X-Title`、`User-Agent`）

## [0.22.3] - 2026-04-25

### 新增

- **阿里云百炼**：新增 **DeepSeek-V4-Flash** 与 **DeepSeek-V4-Pro** 按量付费模型
- **腾讯云 TokenHub**：新增 **DeepSeek-V4-Flash** 与 **DeepSeek-V4-Pro** 按量付费模型

## [0.22.2] - 2026-04-24

### 修复

- **扩展激活失败**：修复 usages 缓存文件损坏时可能导致扩展启动阶段 JSON 解析异常、进而无法激活的问题（[#143](https://github.com/VicBilibily/GCMP/issues/143)）
- **用量缓存写入可靠性**：`usages/index.json` 与各日期 `stats.json` 改为串行化的原子写入，降低并发覆盖或中断写入导致缓存文件损坏的风险

## [0.22.1] - 2026-04-24

### 新增

- **MiniMax**：[#122](https://github.com/VicBilibily/GCMP/pull/122) [#135](https://github.com/VicBilibily/GCMP/issues/135) Coding Plan 模型支持图片输入，通过对话图片桥接的独立模块实现，利用 Vision API 将图片自动转为文字描述

## [0.22.0] - 2026-04-24

### 新增

- **DeepSeek**：全面升级至 DeepSeek V4 系列模型
    - 新增模型：**DeepSeek-V4 Flash**（快速模式）、**DeepSeek-V4 Pro**（专家模式）
    - 上下文窗口 1M tokens，最大输出 384K tokens
    - 支持推理深度控制（`high` / `max` / `none`）
- **腾讯云**：新增腾讯混元模型 **HY 3 Preview**

### 优化

- **Commit 提示词**：为 commit 消息生成添加 System Role 消息（[#138](https://github.com/VicBilibily/GCMP/issues/138)）

## 历史版本（仅保留功能日志）

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
