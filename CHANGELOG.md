# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.21.7] - 2026-04-08

### 新增

- **智谱AI**：新增模型 **GLM-5.1** (按量计费)

## [0.21.6] - 2026-04-03

### 新增

- **Xiaomi MiMo Token Plan**：新增 Token Plan 套餐接入与专用 API Key 配置
    - 新增 Token Plan 模型：**MiMo-V2-Pro**、**MiMo-V2-Omni**
    - 支持双密钥管理：普通 API Key 与 Token Plan 专用 API Key 分别配置
    - 支持接入点切换：可通过配置向导切换 `中国集群(cn)`、`新加坡集群(sgp)`、`欧洲集群(ams)`

## [0.21.5] - 2026-04-03

### 新增

- **智谱AI**：新增 **GLM-5V-Turbo** (Coding Plan) 多模态编程模型

### 调整

- **@vscode/chat-lib**：升级至 0.42.0
- **Qwen Code**：默认模型 **Qwen3.5-Plus** → **Qwen3.6-Plus**

## [0.21.4] - 2026-04-02

### 新增

- **Kimi 联网搜索工具**：新增 `#kimiWebSearch` 联网搜索工具支持
- **阿里云百炼联网搜索**：新增 `#bailianWebSearch` 联网搜索工具支持
- **智谱AI**：新增模型 **GLM-5V-Turbo**(按量付费)
- **阿里云百炼**：新增模型 **Qwen3.6-Plus**(按量付费)

### 移除

- **快手万擎**：移除已下线的 **KAT-Coder-Pro-V1** 和 **KAT-Coder-Air-V1** 模型

### 优化

- **Kimi 状态栏**：新增并发上限显示
- **MiniMax 状态栏**：重构统一为扁平限频列表，支持每5小时与每周限额双维度展示

## [0.21.3] - 2026-03-30

### 修复

- **智谱AI状态栏**：修复用量限额类型识别逻辑，修正周限额与5小时限额的 `unit` 值判断

## [0.21.2] - 2026-03-27

### 新增

- **快手万擎**：新增 **KAT-Coder-Pro-V2** 模型

## [0.21.1] - 2026-03-27

### 新增

- **智谱AI**：新增 **GLM-5.1** 模型（Coding Plan）

## [0.21.0] - 2026-03-27

### 新增

- **腾讯云 Token Plan**：新增 Token Plan 套餐接入与专用 API Key 配置
- **Anthropic 原生联网搜索**：Anthropic 模式新增 `webSearchTool` 配置（仅 Claude 模型）
- **模型配置能力**：新增模型级 `thinking`、`reasoningEffort` 选项，允许手动调整模型思考模式及思考强度

### 调整

- **VS Code 兼容性**：同步 VS Code 1.110.0 API 定义，升级 `@vscode/chat-lib` 至 0.41.1 并适配接口变更

### 移除

- **iFlow CLI**：移除 iFlow CLI 认证提供商及相关配置入口

## 历史版本

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
- **性能优化**：FIM/NES 内联提示采用懒加载机制，模块分包编译

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、心流AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
