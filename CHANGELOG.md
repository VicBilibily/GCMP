# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.18.21] - 2026-02-03

### 新增

- **摩尔线程**：新增摩尔线程 AI Coding Plan 提供商支持
    - 基于 Anthropic 兼容接口，提供智谱 GLM-4.7 系列模型服务

## [0.18.20] - 2026-02-03

### 修复

- **Token 统计 - 提供商显示**：修复提供商名称显示不一致问题
    - 修复小时统计图表、小时统计详情、提供商统计、请求记录等多个组件的提供商名称显示

### 完善

- **Token 统计 - 性能指标**：完善异常数据过滤逻辑
    - 平均输出速度计算：过滤掉 > 1000 tokens/秒的异常数据，避免统计失真

## [0.18.19] - 2026-02-03

### 完善

- **Token 统计 - 小时统计图表**：优化图表显示
    - 限制图表高度为固定 300px，避免宽度变化时高度自动撑大

## [0.18.18] - 2026-02-03

### 新增

- **Token 统计 - 小时统计图表**：新增 Chart.js 可视化图表展示提供商性能指标趋势
    - 新增输出速度图表：展示各提供商的平均输出速度（tokens/秒）随时间变化趋势
    - 新增首Token延迟图表：展示各提供商的首Token平均延迟（毫秒）随时间变化趋势
    - 支持图表切换按钮，可在速度和延迟两个维度间快速切换

### 完善

- **Token 统计 - 小时统计详情**：完善各小时用量统计的显示层级与交互体验
    - 新增三种视图模式切换：按小时、按提供商、按模型
    - 按小时模式：展示每小时的总用量统计
    - 按提供商模式：按提供商分组，显示各提供商的小时明细数据
    - 按模型模式：按提供商→模型嵌套分组，显示各模型的小时明细数据
    - 新增首Token延迟统计：记录从请求开始到首个Token返回的时间间隔

## [0.18.17] - 2026-02-02

### 完善

- **Token 统计 - 小时统计详情**：完善各小时用量统计的显示层级与性能指标
    - 新增按提供商和模型的嵌套分组显示，支持查看每小时各提供商和各模型的详细用量
    - 新增首Token延迟统计：记录从请求开始到首个Token返回的时间间隔

## [0.18.16] - 2026-01-30

### 完善

- **Kimi For Coding 状态栏**：同步官方调整用量显示格式

## [0.18.15] - 2026-01-30

### 新增

- **火山方舟**：新增多个 Coding Plan 专属模型支持
    - **Ark-Code-Latest**：支持选用 Doubao-Seed-Code、DeepSeek-V3.2、GLM-4.7、Kimi-k2-thinking、Kimi-K2.5 模型，也可开启 Auto 模式，根据场景选择最优模型
    - 指定模型支持：`Doubao-Seed-Code`、`Kimi-K2.5`、`GLM-4.7`、`Deepseek V3.2`、`Kimi-K2-Thinking`

## [0.18.14] - 2026-01-30

### 新增

- **MistralAI**：新增 MistralAI 提供商支持
    - 支持 **Codestral** 系列模型（MistralAI 代码补全专用模型）
    - 支持 FIM（Fill In the Middle）代码补全功能
    - 支持 NES（Next Edit Suggestions）代码补全功能

### 完善

- **FIM/NES 参数处理**：完善 `extraBody` 参数的处理逻辑
    - 当 `extraBody` 中的参数值为 `null` 时，自动从请求体中删除该参数
    - 避免传递 `null` 值导致部分提供商 API 报错

## [0.18.13] - 2026-01-29

### 完善

- **扩展生命周期管理**：完善资源清理与停用逻辑
    - 修复 Commit 消息生成命令的 disposables 注册，确保正确清理
    - 在扩展停用时清理所有 registered disposables，避免内存泄漏
    - 添加 CompatibleModelManager 的清理逻辑
    - 优化 `checkGitAvailability()` 的 Disposable 返回实现

## [0.18.12] - 2026-01-29

### 完善

- **Commit 消息生成**：完善 Git 可用性检测与 UI 控制
    - 移除 `vscode.git` 扩展依赖，改为运行时动态检测
    - 新增 `checkGitAvailability()` 函数，异步检测 Git API 可用性
    - 新增 `gcmp.gitAvailable` 上下文变量，控制 Commit 消息生成按钮的显示
    - 当 Git 不可用时，自动隐藏相关按钮并记录警告日志

## [0.18.11] - 2026-01-28

### 修复

- **AnthropicHandler**：修复 usage 对象的处理逻辑
    - 在处理 `message_delta` 事件时，使用 `Object.assign` 正确合并 usage 数据

### 完善

- **Token 统计**：完善缓存 Token 的解析与统计
    - 新增 `cached_tokens` 字段支持，兼容 Responses API 格式的缓存 token 数据
    - 支持从多个字段读取缓存 token 数量（`input_tokens_details.cached_tokens` 或 `cached_tokens`）
    - 优化不同 API 格式（Anthropic / Responses API）的缓存 token 统计逻辑

## [0.18.10] - 2026-01-28

### 完善

- **Gemini HTTP SSE 模式**(实验性)：完善会话状态追踪
    - 流式响应时正确提取并报告 `sessionId` 和 `responseId`

## [0.18.9] - 2026-01-28

### 新增

- **Token 统计 - 平均输出速度**：新增流式响应的平均输出速度统计与显示
    - 所有 Handler 记录流开始/结束时间，使用各模式的标准开始事件（`message_start`、`response.started`、首个 chunk 等）
    - 状态栏 Tooltip 和 WebView 详细视图显示平均输出速度（单位：t/s）

### 重构

- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
    - 所有 Handler（openaiHandler、openaiCustomHandler、openaiResponsesHandler、geminiHandler、anthropicHandler）统一通过 StreamReporter 进行流式输出，不再直接调用 `progress.report`
    - 文本内容（text）采用累积批量输出策略（20 字符阈值），与思考内容（thinking）保持一致

## [0.18.8] - 2026-01-27

### 新增

- **阿里云百炼**：新增 `通义千问3-Max (Thinking)` 模型
- **MoonshotAI**：新增 `Kimi-K2.5` 系列模型
    - **Kimi-K2.5**：Kimi 迄今最智能的模型，在 Agent、代码、视觉理解及一系列通用智能任务上取得开源 SoTA 表现
    - **Kimi-K2.5-Thinking**：支持思考模式的 Kimi-K2.5 变体

## [0.18.7] - 2026-01-27

### 修复

- **AnthropicConverter**：
    - 合并同一 `tool_use_id` 的 `tool_result`，避免出现 “tool_use ids must be unique” [#59](https://github.com/VicBilibily/GCMP/issues/59)
    - `tool_result` 内的 `cache_control` 合并到前一内容块，避免拆分导致结构异常

## [0.18.6] - 2026-01-26

### 完善

- **OpenAIHandler**：完善 OpenAI 系列处理器的思考内容处理

## [0.18.5] - 2026-01-26

### 回滚

- 撤销 0.18.4 的重构：重新测试验证 Copilot 对思考内容的高频返回依旧存在兼容问题

## [0.18.4] - 2026-01-26

### ~~重构~~

- **思考内容输出机制**：~~重构思考内容（thinking/reasoning）的流式输出逻辑，移除缓冲机制实现实时输出~~
    - 移除 `thinkingContentBuffer` 和 `MAX_THINKING_BUFFER_LENGTH` 缓冲机制
    - 思考内容现在在接收到时立即输出，不再等待累积到阈值（~~Copilot已完成兼容，无需在插件处理思考累积~~）
    - 统一 `openaiHandler`、`openaiCustomHandler`、`anthropicHandler` 三个处理器的思考链结束逻辑
    - 新增 `endThinkingChain` 辅助方法，确保在文本内容/工具调用出现前正确结束思维链
    - 优化 OpenAI SDK 事件处理顺序，确保 `chunk` 事件中的 `reasoning_content` 优先处理

## [0.18.3] - 2026-01-26

### 重构

- **会话状态管理**：重构会话缓存机制，从中心化摘要匹配迁移到分布式 Stateful Marker 模式
    - 参考 `microsoft/vscode-copilot-chat` 的 StatefulMarker 设计，通过 `LanguageModelDataPart` 传递会话状态
    - 会话状态通过 `sessionId`、`responseId`、`expireAt` 等字段在消息流中传递
    - 支持 `openai-responses` 和 `anthropic` 两种 SDK 模式的状态追踪
    - 优化缓存复用逻辑，豆包/火山方舟 Responses API 支持过期时间检查与消息截断
    - 架构更清晰，代码更简洁，对齐官方设计模式

## [0.18.2] - 2026-01-23

### 完善

- **请求取消/中止信号**：完善多 SDK/HTTP handler 对 `AbortSignal` 的接入与取消行为一致性
    - ps: 截至目前为止，官方仍未完善手动停止对话时传递取消信号的特性，当前仅为预补充实现完善。

## [0.18.1] - 2026-01-23

### 依赖更新

- **FIM/NES内联提示**：更新官方依赖包版本
    - `@vscode/chat-lib`: `0.2.0` → `0.3.0`

## [0.18.0] - 2026-01-23

### 调整

- **资源调整**：更新插件的 Logo 图标
- **Thinking 上下文**：移除 `includeThinking` 配置项（历史配置将被忽略）
    - 只要模型/网关返回了 thinking，插件将默认在多轮对话中携带对应 thinking 作为上下文

## 历史版本

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能（基于 VS Code Language Model API），支持多仓库场景和自动推断提交风格
- **模型编辑器**：新增从 API 获取模型列表功能，支持多种响应格式解析
- **阿里云百炼**：新增 Coding Plan 套餐专属模型接入（`Qwen3-Coder-Plus`），支持专属 API Key 和 Usage Token 统计
- **Anthropic Compatible**：支持流式请求的会话粘性缓存（客户端驱动）
- **火山方舟**：新增 Responses API 上下文缓存模型适配，支持缓存续接和过期时间管理
- **OpenAI Responses API 支持**(实验性)：调整请求参数与会话标识策略

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **CLI 认证支持**：新增 CLI 工具认证模式，支持 iFlow CLI、Qwen Code CLI、Gemini CLI 进行 OAuth 认证
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、拒绝内容处理、Token 统计和缓存增量传递
- **Thinking输出**：`outputThinking` 参数全量移除，扩展默认始终输出思考内容
- **Token计数**：完善图片附件 token 估算逻辑
- **配置调整**：`gcmp.maxTokens` 默认值调整为 `16000`，上限调整为 256000
- **OpenAI接口**：默认不再传递 `tool_choice: 'auto'`

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能
- **智谱AI用量查询**：新增状态栏显示剩余用量
- **兼容模式成熟化**：OpenAI/Anthropic Compatible Provider 正式发布，支持 openai-sse 响应格式，内置 OpenRouter、AIHubMix 等提供商余额查询
- **性能优化**：FIM/NES 内联提示采用懒加载机制，模块分包编译
- **配置优化**：`gcmp.maxTokens` 上限调整为 256000，完善配置编辑智能提示和模型可视化编辑表单

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 extraBody 和自定义 Header，新增模型缓存系统和记忆功能
- **提供商扩展**：MiniMax、智谱AI、MoonshotAI、火山方舟、快手万擎等提供商新增模型和功能

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、心流AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
