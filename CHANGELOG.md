# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.15.10] - 2025-12-18

### 调整

- **火山方舟** 提供商新增模型 `Doubao-Seed-1.8-251215`。
- **快手万擎** 提供商 移除 推理接入点设置向导，选中预置模型即可使用。
    - 预置接入点已提供 `KAT-Coder-Pro-V1` 及 `KAT-Coder-Air-V1` 模型。

## [0.15.9] - 2025-12-18

### 调整

- **OpenAI / Anthropic Compatible** 新增模型可视化编辑表单，移除分步操作流程向导。

## [0.15.8] - 2025-12-15

- **智谱AI** 提供商支持切换到国际站(z.ai)，实测可与国内站互通。

## [0.15.7] - 2025-12-15

### 调整

- **配置参数上限调整**：
    - `gcmp.maxTokens` 允许最大值从 `32768` 调整为 `256000`
    - FIM补全 `maxTokens` 允许最大值从 `1000` 调整为 `16000`
    - NES补全 `maxTokens` 允许最大值从 `1000` 调整为 `16000`
- **DeepSeek** 模型参数调整：
    - `DeepSeek-V3.2 (Reasoner)` 思考模式 `maxTokens` 从 `32000` 调整为 `64000`

## [0.15.6] - 2025-12-15

### 新增

- **配置编辑智能提示优化**：
    - 为 `gcmp.compatibleModels.[].provider` 提供编辑时的可用提供商智能提示
    - 为 `gcmp.[fim|nes]Completion.modelConfig.provider` 提供模型配置中的可用提供商编辑智能提示
    - 完善 `gcmp.providerOverrides` 覆盖模型设置的ID字段的智能提示

### 修复

- **Anthropic SDK 思考模式优化**：思考模式没有输出 content 正文而响应 stop 时的处理，现尝试输出 `<think/>` 占位文本以确保响应消息完整性，避免工具提示 `很抱歉，未返回响应。`。

## [0.15.5] - 2025-12-14

### 调整

- **Anthropic SDK** 模式下的 `model.includeThinking=true` 时，发送消息前检查并确保所有 `assistant` 消息都包含 `type:'thinking'` 的消息。

## [0.15.4] - 2025-12-14

- **FIM内联提示功能** 完善 `阿里云百炼` 的 Completions 接口特殊支持

**示例配置**

```json
  "gcmp.fimCompletion.modelConfig": {
    "provider": "dashscope",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen-coder-turbo-latest",
    "maxTokens": 100
  }
```

## [0.15.3] - 2025-12-13

### 新增

- **融合实现 FIM 和 NES 内联提示功能**：
    - 整合 FIM (Fill In the Middle) 和 NES (Next Edit Suggestions) 两种代码补全模式
    - **启用策略说明**：
        - **自动触发 + manualOnly: false**：根据光标位置智能选择提供者
            - 光标在行尾 → 使用 FIM（适合补全当前行）
            - 光标不在行尾 → 使用 NES（适合编辑代码中间部分）
            - 如果 NES 无结果或补全无意义，则自动回退到 FIM
        - **自动触发 + manualOnly: true**：仅发起 FIM 请求（NES 需手动触发）
        - **手动触发**（按 `Alt+/`）：直接调用 NES，不发起 FIM
        - **模式切换**（按 `Shift+Alt+/`）：在自动/手动间切换（仅影响 NES）

**示例配置**

```json
{
    "gcmp.fimCompletion.enabled": true,
    "gcmp.fimCompletion.debounceMs": 500,
    "gcmp.fimCompletion.timeoutMs": 5000,
    "gcmp.fimCompletion.modelConfig": {
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com/beta",
        "model": "deepseek-chat",
        "maxTokens": 100
    },
    "gcmp.nesCompletion.enabled": true,
    "gcmp.nesCompletion.debounceMs": 500,
    "gcmp.nesCompletion.timeoutMs": 10000,
    "gcmp.nesCompletion.manualOnly": false,
    "gcmp.nesCompletion.modelConfig": {
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "maxTokens": 200
    }
}
```

## [0.15.2] - 2025-12-12

### 调整

- 各提供商 `DeepSeek-V3.2` 模型的思考模式名称调整：
    - **DeepSeek**：`思考模式` -> `Reasoner`
    - **火山方舟**：`思考模式` -> `Thinking`
- **DeepSeek** 提供商移除内置模型 `DeepSeek-V3.2-Speciale`
- **百度千帆** 提供商移除内置测试支持，就发布会说得很牛。

## [0.15.1] - 2025-12-12

### 调整

- **火山方舟** 提供商 `DeepSeek-V3.2` 模型参数调整：
    - `maxInputTokens`: `128000` -> `96000`

## [0.15.0] - 2025-12-12

### 新增

- 内置支持 NES (Next Edit Suggestions) 代码补全

**示例配置**

```json
  "gcmp.nesCompletion.enabled": true,
  "gcmp.nesCompletion.debounceMs": 500, // 自动触发补全的防抖延迟
  "gcmp.nesCompletion.timeoutMs": 10000, // NES 补全 OpenAI 接口请求超时时间
  "gcmp.nesCompletion.manualOnly": false, // 启用手动 `Alt+/` 快捷键触发代码补全提示
  "gcmp.nesCompletion.modelConfig": {
    "provider": "zhipu", // 提供商ID, 其他请先添加 OpenAI Compatible 自定义模型 provider 并设置 ApiKey。
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4", // 指定 OpenAI Endpoint 的 BaseUrl 地址
    "model": "glm-4.6",
    "extraBody": {
      "thinking": { "type": "disabled" }
    },
    // "provider": "siliconflow",
    // "baseUrl": "https://api.siliconflow.cn/v1",
    // "model": "zai-org/GLM-4.6",
    // "provider": "deepseek",
    // "baseUrl": "https://api.deepseek.com/v1",
    // "model": "deepseek-chat",
    "maxTokens": 100
  }
```

## 历史版本

### 0.14.0 - 0.14.19 版本 (2025-11-30 - 2025-12-11)

**兼容模式成熟化**：

- **正式发布**：OpenAI/Anthropic Compatible Provider 结束 GA 测试阶段
- **余额查询扩展**：内置 OpenRouter、AI Ping、AIHubMix、硅基流动 等提供商余额查询
- **思考过程支持**：新增 includeThinking 参数，支持多轮对话思考过程传递
- **SSE兼容模式**：新增 openai-sse 非标准模型接口响应格式支持

**提供商深度优化**：

- **DeepSeek**：新增 DeepSeek-V3.2 模型，支持思考模式 Agent 工具调用，新增余额查询
- **MoonshotAI**：新增余额查询支持，优化思考模型输出显示
- **火山方舟**：新增 DeepSeek-V3.2 模型，扩展协作奖励计划模型
- **智谱AI**：新增 GLM-4.6V 系列模型（Flash、Thinking）
- **MiniMax**：支持国际站 Coding Plan 编程套餐接入

**生命周期管理**：

- **ModelScope魔搭社区**：正式移除内置支持，转为自定义兼容模式
- **百灵大模型**：移除内置支持，不适合开发用途
- **心流AI**：计划 2025-12-31 移除内置支持
- **AI Ping**：正式结束内置支持并移除

**用户体验改进**：

- **状态栏优化**：完善密钥变更同步显示，支持单独隐藏图标
- **错误处理优化**：发生错误时不再自动打开输出窗口，减少干扰
- **思考内容输出**：解决思考内容换行问题，优化输出显示

### 0.9.0 - 0.13.6 版本 (2025-10-29 - 2025-11-29)

**核心架构演进**：

- **兼容模式支持**：新增 `OpenAI / Anthropic Compatible` Provider，支持完全自定义 API 接入
- **配置系统增强**：支持 extraBody 扩展请求参数、自定义 Header 请求头
- **交互式配置向导**：为智谱AI、快手万擎等提供商提供可视化配置界面
- **模型缓存系统**：使用 VS Code globalState 持久化存储，支持版本检查、API 密钥哈希校验、24小时过期机制
- **记忆功能**：新增 `gcmp.rememberLastModel` 配置，记录上次使用的模型，重启后自动恢复选择
- **自动重试机制**：ModelScope 及兼容模式支持 429 状态码自动重试，减少 Agent 操作中断

**提供商扩展与深度优化**：

- **MiniMax**：正式列为常规支持提供商，新增 Coding Plan 编程套餐专用 API 密钥支持，新增网络搜索 (`#minimaxWebSearch`) 功能
- **智谱AI**：新增交互式配置向导，支持修改 API Key 和 MCP 搜索模式配置，新增 GLM-4.6-Thinking 模型模式
- **MoonshotAI**：新增 Kimi-K2-Thinking 和 Kimi-K2-Thinking-Turbo 思考模型，固定采用 `{ "temperature": 1.0, "top_p": 1 }` 参数
- **火山方舟**：新增 Doubao-Seed-Code 模型支持，兼容 Coding Plan 套餐模型
- **百度智能云**：新增 ERNIE-5.0 模型支持，更名为产品名称"百度千帆"
- **快手万擎**：新增交互式配置向导，支持修改 API Key 和推理点ID配置
- **百灵大模型**：改用 Anthropic SDK 进行通讯，从 Beta 转为常规支持提供商

**模型管理与维护**：

- **计费模型明确**：按量计费模型在模型选择列表中明确强调计费，避免错误选用非编程套餐模型造成欠费
- **模型清理策略**：移除加价X计费模型（GLM-4.5-X、GLM-4.5-AirX）、免费使用时期的按量计费模型（MiniMax-M2-Stable）
- **EOL 提供商清理**：移除硅基流动、无问芯穹、基石智算、腾讯云、华为云、京东云、七牛云、零克云、UCloud、SophNet、并行智算云、PPIO派欧云、蓝耘元生代等停止支持的提供商
- **三方模型清理**：存在自主模型的提供商移除所有三方模型，仅保留自主模型

**用户体验优化**：

- **状态栏订阅用量显示**：新增 MiniMax Coding Plan 套餐周期使用比例显示，Kimi For Coding 周期剩余额度显示
- **订阅状态自动刷新**：新增用户活跃记录，30分钟无操作则暂停自动刷新用量信息，优化资源使用
- **模型变更通知机制**：采用通知机制让模型配置刷新，避免重新初始化模型提供方造成整个服务重置
- **配置编辑智能提示**：为 `gcmp.providerOverrides` 提供完整的编辑 schema 输入提示，提升配置效率
- **编辑工具模式优化**：Claude 编辑工具模式指向 `claude-sonnet-4.5` 模型家族，移除 Grok 实验性编辑工具模式配置选项

**生命周期管理**：

- **AI Ping**：恢复为测试状态并持续提供维护，计划 2025-11-30 正式移除内置支持
- **ModelScope 魔搭社区**：状态从 Alpha 转换为 Beta，模型维护更新
- **心流AI(iFlow)**：移除不兼容及已下线的模型（DeepSeek-V3-671B、Qwen3-Coder-480B-A35B）

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：

- **多提供商支持**：智谱AI、心流AI、MoonshotAI、DeepSeek、MiniMax 等模型提供商接入
- **国内云厂商支持**：阿里云百炼、火山方舟、百度智能云、ModelScope、快手万擎等云厂商集成
- **联网搜索**：智谱AI网络搜索工具集成，支持 MCP SDK 客户端连接
- **编辑工具优化**：支持多种编辑工具模式（Claude/GPT-5/Grok）
- **配置系统**：支持 temperature、topP、maxTokens 等参数配置，支持提供商配置覆盖
- **Token 计算**：集成 @microsoft/tiktokenizer 进行 token 计算
- **多 SDK 支持**：集成 OpenAI SDK 和 Anthropic SDK 处理不同模型请求
- **思维链输出**：思维模型支持输出推理过程
- **自动重试机制**：`ModelScope`及`OpenAI / Anthropic 兼容模式`支持 429 状态码自动重试，减少 Agent 操作中断
