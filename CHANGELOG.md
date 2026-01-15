# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.16.26] - 2026-01-15

### 新增

- **Gemini CLI**：新增预览模型预置，仅部分订阅账号可用：
    - `Gemini 3 Pro Preview` 及 `Gemini 3 Flash Preview`

## [0.16.25] - 2026-01-14

### 调整

- **火山方舟**： 调整 Coding Plan 内置可用模型列表
    - 移除 `DeepSeek-V3.2`
    - 新增 [`Ark-Code-Latest`(Thinking)](https://www.volcengine.com/docs/82379/1925114?lang=zh#51b87c17)

## [0.16.24] - 2026-01-13

### 调整

- **快手万擎**：调整 `KAT-Coder-Pro-V1` 模型显示名称，增加 `(按量付费)` 标识。
- **OpenAI接口**：由于大多数模型都默认传递 `tools` 时默认 `tool_choice: 'auto'`，现默认不再传递此值。

## [0.16.23] - 2026-01-12

### 调整

- **Thinking输出**：`outputThinking` 参数全量移除，扩展默认始终输出思考内容（若模型/网关返回 thinking）。
- **兼容模型配置**：移除 JSON Schema 与可视化模型编辑器中的 `outputThinking` 选项，历史配置将被忽略。

## [0.16.22] - 2026-01-12

### 完善

- **Token计数**：完善图片附件 token 估算逻辑（对齐 `microsoft/vscode-copilot-chat` 的 OpenAI Vision 图片成本估算）。
- **上下文窗口占用比例状态栏**：本轮消息包含图片附件时，图片 token 单独统计（新增“本轮图片”，本轮消息不含图片）。

## [0.16.21] - 2026-01-12

### 调整

- **iFlow CLI**：移除不兼容模型 `DeepSeek-V3.2` (iFlow API 不兼容此模型的 `stream: true` 流式响应)。

## [0.16.20] - 2026-01-12

### 完善

- **CLI认证**：静默认证时增加 500ms 超时处理，避免 Google 无法连接卡住后续流程。

## [0.16.19] - 2026-01-11

### 完善

- **Gemini HTTP SSE 模式**(实验性)：完善思考模式兼容
    - 兼容部分网关的思考签名，现同时解释和传递 `thoughtSignature` 和 `thought_signature`。
    - `extraBody` 将传递到 `generationConfig` 并在 gemini 模式支持对象合并。

## [0.16.18] - 2026-01-11

### 新增

- **Gemini CLI**：新增 Gemini CLI 认证模式，支持通过 Gemini CLI 进行 OAuth 认证
    - 支持使用 Gemini CLI 进行 `Login with Google` 认证（需要本地安装 Gemini CLI）

## [0.16.17] - 2026-01-11

### 完善

- **Gemini HTTP SSE 模式**(实验性)：完善配置智能提示体验
    - 在 JSON Schema 中为 `sdkMode` 添加 `gemini-sse` 选项

## [0.16.16] - 2026-01-11

### 新增

- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关
    - 支持自定义 `baseUrl`，适配不同网关的端点结构（前缀/版本/完整端点）
    - 支持自定义鉴权头（`Authorization`/`X-API-Key`/`API-Key`/`X-Goog-Api-Key`）
    - 支持流式输出（SSE `data:` 和纯 JSON 行），兼容标准 SSE 与类 SSE 实现
    - 支持思维链输出（`thoughtSignature` + `thinking` parts）
    - 支持工具调用（`functionCall`/`functionResponse`），自动对齐 tool response 顺序
    - 支持多模态输入（图片 `inlineData` base64 编码）
    - 支持系统消息（`systemInstruction`）与 `includeThinking`（thinking 作为输入上下文）
    - 支持 `extraBody` 注入 Gemini 请求体字段（与 OpenAI/Anthropic 扩展点一致）
    - 支持 `usageMetadata` 原样透传，便于后续统计解析（`promptTokenCount`/`candidatesTokenCount`/`cachedContentTokenCount` 等）
    - 新增 `geminiConverter.ts` 模块，实现 JSON Schema → Gemini Schema 转换（`$ref`/`nullable`/类型映射/properties/items/required/enum）
    - 为所有关键方法添加中文 JSDoc 与详细注释，便于后续维护与网关兼容性增强

## [0.16.15] - 2026-01-10

- 无功能调整，仅调整样式和移动文件

## [0.16.14] - 2026-01-10

### 完善

- **OpenAI Responses API 支持**(实验性)
    - 完善 火山方舟 的 Responses API 的缓存增量传递消息支持

```json
  "gcmp.compatibleModels": [
    {
      "id": "doubao-seed-1-8",
      "name": "Doubao-Seed-1.8-251228 (Responses)",
      "model": "doubao-seed-1-8-251228",
      "provider": "volcengine",
      "sdkMode": "openai-responses",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
      "tooltip": "全新面向多模态 Agent 场景定向优化模型。更强Agent能力、升级多模态理解、更灵活的上下文管理。",
      "maxInputTokens": 224000,
      "maxOutputTokens": 64000,
      "includeThinking": true,
      "capabilities": {
        "toolCalling": true,
        "imageInput": true
      },
      "extraBody": {
        "caching": { "type": "enabled" }
      },
      "useInstructions": false
    }
  ]
```

## [0.16.13] - 2026-01-09

### 完善

- 完善 OpenAI SDK / Responses API 的错误输出机制，正确输出真实的返回错误

## [0.16.12] - 2026-01-09

### 新增

- **OpenAI Responses API 支持**(实验性)
    - 新增针对 `Codex` 转发的缓存支持，模型ID 包含 `gpt` 或 `codex` 时默认启用相关逻辑。

## [0.16.11] - 2026-01-08

### 新增

- **OpenAI Responses API 支持**(实验性)
    - 新增针对 `火山方舟` 的 Responses API 的兼容

## [0.16.10] - 2026-01-08

### 新增

- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，使用 OpenAI Responses API 进行消息格式转换
    - 支持思维链（reasoning）内容输出，包括 `response.reasoning_text.delta/done` 和 `response.reasoning_summary_text.delta/done` 事件
    - 支持拒绝内容（refusal）处理，包括 `response.refusal.delta/done` 事件
    - 新增 `useInstructions` 配置选项，控制是否使用 `instructions` 参数传递系统消息
    - 默认使用用户消息传递系统消息（兼容性更好），设置为 `true` 时使用 `instructions` 参数
    - 支持 Responses API 格式的 Token 统计（`input_tokens`、`output_tokens`）

## [0.16.9] - 2026-01-06

### 调整

- `gcmp.maxTokens`：默认值由 `8192` 调整为 `16000`。
- **MoonshotAI**：移除过时模型 `Kimi-K2-0711-Preview`。
- **快手万擎**：新增 `KwaiKAT Coding Plan` 内置可用模型。
- **火山方舟**： 调整内置可用模型列表
    - 更新：`Doubao-Seed-1.8-251215` 至 `Doubao-Seed-1.8-251228`。
    - 移除：`Doubao-Seed-1.6-Flash-250828`、`Doubao-Seed-1.6-Thinking-250715`、`Doubao-Seed-1.6-Vision-250815`

## [0.16.8] - 2026-01-04

### 完善

- **iFlow CLI**：降低 oauth/getUserInfo 的调用频率。
    - 当 accessToken 失效时，可能 apiKey 依旧可用。
    - 一个 accessToken 最多尝试刷新 apiKey 请求 3 次。

## [0.16.7] - 2026-01-04

### 完善

- **iFlow CLI**：刷新凭证和临时凭证都已失效时提示重新通过 iFlow CLI 登陆

## [0.16.6] - 2026-01-03

### 修复

- **Token消耗统计功能**：部分提供商模型不返回usage信息时保持显示预估输入值显示

## [0.16.5] - 2026-01-03

### 修复

- **iFlow CLI**：修正通过菜单 `刷新认证状态` 操作未进行认证状态刷新的问题

## [0.16.4] - 2026-01-02

### 新增

- **CLI 认证支持**：新增 CLI 工具认证模式，支持通过本地 CLI 工具进行 OAuth 认证
    - **iFlow CLI**：支持 iFlow CLI 认证，需要先安装 `@iflow-ai/iflow-cli`
    - **Qwen Code CLI**：支持 Qwen Code CLI 认证，需要先安装 `@qwen-code/qwen-code`

- **Qwen Code CLI**：新增阿里云通义千问命令行编程助手认证支持

### 调整

- **iFlow CLI**：从原定移除 `iFlow`，现已调整为通过 CLI 认证模式接入

## [0.16.3] - 2026-01-01

### 调整

- **上下文窗口占用比例状态栏**：细化完善消息细分，环境信息占用单独列出（之前没有细分归入了历史信息）。

## [0.16.2] - 2026-01-01

### 调整

- **上下文窗口占用比例状态栏**：详情信息显示新增各部分消息占用统计信息，包括：系统提示、可用工具、压缩消息、历史消息、思考内容、会话消息。
- **Token消耗统计功能**：统计详情界面在窗口可视宽度小于768px时自动隐藏日期列表。

## [0.16.1] - 2025-12-30

### 调整

- **Token消耗统计功能**：状态栏提示信息中提供商只有一个时无需显示合计行。

## [0.16.0] - 2025-12-29

### 新增

- **Token消耗统计功能**：
    - **文件日志记录**：基于文件系统的持久化日志记录，无存储限制，支持长期数据保存
    - **多格式支持**：统一处理 OpenAI、Anthropic 等不同提供商的 usage 数据格式
    - **详细记录**：记录每次 API 请求的模型和用量信息，包括：
        - 请求 ID、时间戳、提供商、模型
        - 预估输入 token、实际输入/输出 token
        - 请求状态（预估/完成/失败）
    - **智能统计**：
        - 按日期、小时自动组织日志文件
        - 支持总计、按提供商、按模型、按小时等多维度统计
        - 差分计算优化，仅重新计算变更的小时数据
        - 自动检测并重新生成过期的统计数据
    - **状态栏显示**：
        - 实时显示今日 Token 用量（输入+输出）
        - 30秒自动刷新，支持用户活跃检测（30分钟无操作暂停刷新）
        - 点击状态栏打开详细统计视图
    - **WebView 详细视图**：
        - 可视化展示 Token 消耗统计，支持查看历史记录
        - 按日期列表展示，支持选择特定日期查看详情
        - 按提供商和模型分组显示统计数据
        - 分页显示请求记录，支持查看每条请求的详细信息
        - 支持打开日志存储目录进行手动管理
    - **数据管理**：
        - 可配置历史数据保留天数（`gcmp.usages.retentionDays`，默认100天，0表示永久保留）
        - 自动清理过期日志文件
    - **性能优化**：
        - 异步初始化，不阻塞扩展启动
        - 文件索引缓存，快速读取历史数据
        - 智能刷新机制，仅在数据变更时更新视图
        - 定时清理任务，自动清理过期的待更新日志

### 配置说明

```json
{
    "gcmp.usages.retentionDays": 100
}
```

**使用方式**：

- 点击状态栏的 Token 用量显示，或通过命令面板执行 `GCMP: 查看今日 Token 消耗统计详情` 命令打开详细视图
- 在详细视图中可查看历史记录、按日期筛选、查看每条请求的详细信息
- 支持打开日志存储目录进行手动数据管理

## 历史版本

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能
- **智谱AI用量查询**：新增状态栏显示剩余用量
- **兼容模式成熟化**：OpenAI/Anthropic Compatible Provider 正式发布，支持 includeThinking 参数和 openai-sse 响应格式，内置 OpenRouter、AIHubMix 等提供商余额查询
- **性能优化**：FIM/NES 内联提示采用懒加载机制，模块分包编译
- **提供商调整**：
    - 智谱AI：新增 GLM-4.6V 系列、GLM-4.7 (Thinking) 模型，支持切换到国际站
    - MiniMax：支持国际站 Coding Plan，新增 M2.1 系列模型
    - 火山方舟：新增 DeepSeek-V3.2、Doubao-Seed-1.8-251215 模型
    - MoonshotAI：新增余额查询，Kimi For Coding 合并到 MoonshotAI，新增多密钥设置向导
    - DeepSeek：新增 DeepSeek-V3.2 模型和余额查询
- **配置优化**：`gcmp.maxTokens` 上限调整为 256000，完善配置编辑智能提示和模型可视化编辑表单

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 extraBody 和自定义 Header，新增模型缓存系统和记忆功能
- **提供商扩展**：
    - MiniMax：正式列为常规支持提供商，新增 Coding Plan 编程套餐和网络搜索功能
    - 智谱AI：新增交互式配置向导和 GLM-4.6-Thinking 模型
    - MoonshotAI：新增 Kimi-K2-Thinking 系列模型
    - 火山方舟：新增 Doubao-Seed-Code 模型
    - 快手万擎：新增交互式配置向导
- **模型管理**：明确计费模型标识，清理加价X计费模型和三方模型

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：

- **多提供商支持**：智谱AI、心流AI、MoonshotAI、DeepSeek 等模型提供商接入
- **国内云厂商支持**：阿里云百炼、火山方舟、快手万擎等云厂商集成
- **联网搜索**：智谱AI网络搜索工具集成，支持 MCP SDK 客户端连接
- **编辑工具优化**：支持多种编辑工具模式（Claude/GPT-5/Grok）
- **配置系统**：支持 temperature、topP、maxTokens 等参数配置，支持提供商配置覆盖
- **Token 计算**：集成 @microsoft/tiktokenizer 进行 token 计算
- **多 SDK 支持**：集成 OpenAI SDK 和 Anthropic SDK 处理不同模型请求
- **思维链输出**：思维模型支持输出推理过程
- **兼容模式支持**：OpenAI / Anthropic 兼容模式，支持自定义 API 接入
- **自动重试机制**：`ModelScope`及`OpenAI / Anthropic 兼容模式`支持 429 状态码自动重试，减少 Agent 操作中断
