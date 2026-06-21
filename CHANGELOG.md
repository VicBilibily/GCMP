# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

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
