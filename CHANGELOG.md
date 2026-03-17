# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.20.5] - 2026-03-17

### 优化

- **CLI 专用提供商提示**：完善 `codex` 和 `gemini` 提供商 ID 的配置验证和 UI 提示，这两个 ID 为 CLI 认证专用

### 新增

- **CLI 认证凭证管理**：CLI 配置向导新增「移除 OAuth 认证凭证」菜单项
    - 仅在凭证文件存在时显示该选项
    - 选择后会在系统文件管理器中定位到凭证文件，用户可手动删除

## [0.20.4] - 2026-03-16

### 新增

- **智谱AI**：：同步新增模型支持 `GLM-5-Turbo`(Thinking)

## [0.20.3] - 2026-03-13

### 新增

- **Gemini CLI**：新增预览模型支持，默认 CLI 版本更新至 0.32.1 [#97](https://github.com/VicBilibily/GCMP/pull/97)
    - **Gemini 3.1 Pro (Preview)**：最新的 Gemini 3.1 Pro 预览版
    - **Gemini 3.1 Pro (Custom Tools)**：自定义工具优先的 Gemini 3.1 Pro 版本

### 重构

- **Handler 架构优化**：重构所有处理器以支持配置动态更新
    - OpenAI、Anthropic、Gemini 等处理器现在通过 `GenericModelProvider` 实例动态获取配置
    - 配置变更时无需重新初始化处理器，提升响应速度和代码可维护性

## [0.20.2] - 2026-03-10

### 新增

- **腾讯云**：新增提供商支持
    - **混元模型**：`Tencent HY 2.0 Instruct`、`Tencent HY 2.0 Think`、`Hunyuan-T1`、`Hunyuan-TurboS`
    - **Coding Plan 编程套餐**：同步支持 GLM-5、MiniMax-M2.5、Kimi-K2.5 等模型
    - **DeepSeek**：支持通过腾讯云 DeepSeek API 专用密钥接入 DeepSeek-V3.2
    - **多密钥管理**：支持付费模型 API Key、Coding Plan 专用密钥、DeepSeek API 专用密钥三种模式

### 优化

- **智谱联网搜索**：更新工具名称以适配新版 MCP WebSearch 服务 (`webSearchPrime` → `web_search_prime`)

## [0.20.1] - 2026-03-06

### 新增

- **火山方舟 Coding Plan**：同步新增模型支持
    - **Doubao-Seed-2.0-lite**：兼顾生成质量与响应速度的通用生产级模型
    - **Doubao-Seed-2.0-pro**：旗舰级全能通用模型，适合复杂推理与长链路任务
    - **MiniMax-M2.5**：编程套餐专属接入点，编程、工具调用和搜索等场景达到 SOTA
- **Codex CLI**：新增模型 **GPT-5.4**

### 优化

- **ChatGPT 状态栏**：完善速率限制解析显示，兼容 5 小时窗口限制

## [0.20.0] - 2026-03-05

### 新增

- **Codex CLI 认证支持**：新增 OpenAI Codex (Codex CLI) 提供商支持，通过 `codex` CLI 命令行工具进行身份验证 [#89](https://github.com/VicBilibily/GCMP/issues/89)
- **ChatGPT 状态栏**：新增 Codex CLI 用量显示支持
- **模型 Family 配置**：新增模型级别的 `family` 配置项，用于在多模型共享同一 API Key 时进行区分，替代原有的全局 `editToolMode` 配置

### 重构

- **用量统计重构**：重构统计聚合口径与字段结构
    - 移除中间字段落盘，仅保留 `firstTokenLatency`/`outputSpeeds` 聚合字段
    - 速度计算改用鲁棒均值（log 空间 MAD + gap），提升数据准确性

## 历史版本

### 0.19.0 - 0.19.17 (2026-02-12 - 2026-02-28)

- **模型与提供商**：智谱AI 新增 GLM-5；MiniMax 新增 M2.5 系列及极速版；阿里云百炼 Coding Plan 新增 Qwen3.5、GLM-4.7、Kimi-K2.5
- **功能优化**：重构 Token 统计缓存机制、优化状态栏统一显示剩余百分比、API Key 输入体验优化、Anthropic cache_control 兼容性改进

### 0.18.0 - 0.18.30 (2026-01-23 - 2026-02-11)

- **会话状态管理**：重构会话缓存机制，从中心化摘要匹配迁移到分布式 Stateful Marker 模式
- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
- **Token 统计**：新增完整的 Token 消耗统计系统，包括平均输出速度、首 Token 延迟、小时统计图表等可视化功能
- **MistralAI**：新增 MistralAI 提供商支持，支持 Codestral 系列模型 FIM/NES 代码补全功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格
- **阿里云百炼**：新增 Coding Plan 套餐专属模型接入，支持专属 API Key 和 Usage Token 统计
- **Anthropic Compatible**：支持流式请求的会话粘性缓存（客户端驱动）
- **火山方舟**：新增 Responses API 上下文缓存模型适配，支持缓存续接和过期时间管理

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **CLI 认证支持**：新增 CLI 工具认证模式，支持 iFlow CLI、Qwen Code CLI、Gemini CLI 进行 OAuth 认证
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、拒绝内容处理、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能
- **性能优化**：FIM/NES 内联提示采用懒加载机制，模块分包编译

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header
- **提供商扩展**：MiniMax、智谱AI、MoonshotAI、火山方舟、快手万擎等提供商新增模型和功能

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、心流AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
