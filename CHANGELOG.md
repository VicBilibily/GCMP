# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.19.10] - 2026-02-23

### 优化

- **配置向导**：优化 MiniMax、阿里云百炼、MoonshotAI 的 Coding Plan 密钥配置提示

## [0.19.9] - 2026-02-22

### 新增

- **OpenAI 自定义处理程序**：新增 `endpoint` 配置字段，支持自定义 API 端点 [#82](https://github.com/VicBilibily/GCMP/issues/82)

### 优化

- **OpenAI Responses API**：完善加密思考内容（`encrypted_thinking`）回传与流式处理逻辑 [#84](https://github.com/VicBilibily/GCMP/issues/84)

## [0.19.8] - 2026-02-21

### 新增

- **阿里云百炼**：Coding Plan 同步新增模型支持
    - **Qwen3.5-Plus**(Thinking)、**Qwen3-Coder-Next**
    - **GLM-4.7**(Thinking)、**Kimi-K2.5**(Thinking)

## [0.19.7] - 2026-02-17

### 新增

- **阿里云百炼**：新增模型 **Qwen3.5-Plus**(Thinking)

### 调整

- **Qwen Code CLI**：调整模型名称 **Qwen3.5-Plus**（原 Qwen3-Coder-Plus）

## [0.19.6] - 2026-02-16

### 优化

- **Anthropic 消息转换器**：优化 `cache_control` 清理逻辑，支持嵌套内容处理 [#81](https://github.com/VicBilibily/GCMP/issues/81)

## [0.19.5] - 2026-02-16

### 新增

- **MiniMax**：
    - Coding Plan 新增极速版模型：**MiniMax-M2.5 极速版**

### 调整

- **MiniMax**：同步官方调整模型命名，"Lightning"更名为"极速版"
    - `MiniMax-M2.5-Lightning` → `MiniMax-M2.5-HighSpeed` (极速版)
    - `MiniMax-M2.1-Lightning` → `MiniMax-M2.1-HighSpeed` (极速版)

## [0.19.4] - 2026-02-16

### 修复

- **Anthropic 消息转换器**：缓解 `cache_control` 在部分中转 API 未正确计算限制导致请求失败的问题 [#81](https://github.com/VicBilibily/GCMP/issues/81)

## [0.19.3] - 2026-02-14

### 新增

- **火山方舟**：
    - Coding Plan 新增模型：**Doubao-Seed-2.0-Code**(Thinking)
    - 新增 `Doubao-Seed-2.0` 系列模型：**lite**、**mini**、**pro**、**Code**

## [0.19.2] - 2026-02-13

### 新增

- **MiniMax**：新增 **MiniMax-M2.5** 模型

### 调整

- **MiniMax状态栏**：显示剩余百分比而非已使用百分比，与其他提供商状态栏保持一致

## [0.19.1] - 2026-02-12

### 修复

- **Compatible Provider**：修复静默模式下错误触发配置向导的问题 [#80](https://github.com/VicBilibily/GCMP/issues/80)

## [0.19.0] - 2026-02-12

### 新增

- **智谱AI**：新增 GLM-5 模型

### 移除

- **配置项移除**：移除 `gcmp.temperature`、`gcmp.topP` 配置项，另移除已不再适用的 `gcmp.rememberLastModel` 配置项及功能实现
    - **替代方案**：如需专属设置，请通过模型的 `extraBody` 参数传递

## 历史版本

### 0.18.0 - 0.18.30 (2026-01-23 - 2026-02-11)

- **会话状态管理**：重构会话缓存机制，从中心化摘要匹配迁移到分布式 Stateful Marker 模式
- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
- **Token 统计**：新增完整的 Token 消耗统计系统，包括平均输出速度、首 Token 延迟、小时统计图表等可视化功能
- **MistralAI**：新增 MistralAI 提供商支持，支持 Codestral 系列模型 FIM/NES 代码补全功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格
- **模型编辑器**：新增从 API 获取模型列表功能，支持多种响应格式解析
- **阿里云百炼**：新增 Coding Plan 套餐专属模型接入，支持专属 API Key 和 Usage Token 统计
- **Anthropic Compatible**：支持流式请求的会话粘性缓存（客户端驱动）
- **火山方舟**：新增 Responses API 上下文缓存模型适配，支持缓存续接和过期时间管理

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **CLI 认证支持**：新增 CLI 工具认证模式，支持 iFlow CLI、Qwen Code CLI、Gemini CLI 进行 OAuth 认证
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、拒绝内容处理、Token 统计和缓存增量传递
- **Token计数**：完善图片附件 token 估算逻辑

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能
- **兼容模式成熟化**：OpenAI/Anthropic Compatible Provider 正式发布，支持 openai-sse 响应格式
- **性能优化**：FIM/NES 内联提示采用懒加载机制，模块分包编译

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header，新增模型缓存系统和记忆功能
- **提供商扩展**：MiniMax、智谱AI、MoonshotAI、火山方舟、快手万擎等提供商新增模型和功能

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、心流AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
