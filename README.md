# GCMP - 提供多个国内原生大模型提供商支持的扩展

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![License](https://img.shields.io/badge/License-MIT-orange)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内主流原生大模型提供商，为开发者提供更加丰富、更适合本土需求的 AI 编程助手选择。
目前已内置支持 智谱AI、MiniMax、MoonshotAI、DeepSeek、阿里云百炼、快手万擎、火山方舟、腾讯云、Xiaomi MiMo、百度千帆 等**原生大模型**提供商。
此外，扩展插件已适配支持 OpenAI 与 Anthropic 的 API 接口兼容模型，支持自定义接入任何提供兼容接口的第三方**云服务模型**。

#### 📢 公告

- **0.20.8 临时兼容项**：针对 VS Code 模型选择器显示模型不全的问题，新增 `gcmp.autoPrefixModelId` 配置项作为临时解决方案。
    - **问题原因**：VS Code 1.111.0 引入模型折叠模式后，当多个提供商存在相同模型 ID 时，选中模型后的可用模型过滤逻辑异常（选中后模型移至顶部，下方列表过滤掉该 modelId，导致同 modelId 的其他提供商的此个模型无法选中）。
    - **解决方案**：启用 `gcmp.autoPrefixModelId` 后，模型 ID 将自动添加提供商前缀（如 `zhipu:::glm-5`），避免 ID 冲突。（若仅使用单一提供商或未遇到此类问题，可无视此临时兼容项）
    - **注意事项**：切换此开关后模型 ID 会变更，需重新在「语言模型」管理页面勾选需要使用的模型。

## 🚀 快速开始

### 1. 安装扩展

在VS Code扩展市场搜索 `GCMP` 并安装，或使用扩展标识符：[`vicanent.gcmp`](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)

### 2. 开始使用

1. 打开 `VS Code` 的 `GitHub Copilot Chat` 面板
2. 在模型选择器的底部选择 `管理模型`，从弹出的模型提供商列表中选择所需的提供商
3. 若第一次使用，选择提供商后会要求设置 ApiKey，根据提示完成API密钥配置后，即可返回模型选择器添加并启用模型
4. 在模型选择器中选中目标模型后，即可开始与AI助手进行对话

## 🤖 内置的AI大模型提供商

> 本扩展仅预置存在自有模型的一线大模型提供商（如具备模型自研能力的主流云厂商），第三方模型接入请使用「OpenAI / Anthropic Compatible」兼容模式。

### [**智谱AI**](https://bigmodel.cn/)

- [**编程套餐**](https://bigmodel.cn/glm-coding)：**GLM-5.1**、**GLM-5V-Turbo**、**GLM-5-Turbo**、**GLM-4.7**、**GLM-4.6**、**GLM-4.6V**、**GLM-4.5-Air**
    - **用量查询**：已支持状态栏显示周期剩余用量，可查看 GLM Coding Plan 用量信息。
- **按量计费**：**GLM-5.1**、**GLM-5V-Turbo**、**GLM-5-Turbo**、**GLM-5**、**GLM-4.7**、**GLM-4.7-FlashX**、**GLM-4.6**、**GLM-4.6V**、**GLM-4.5-Air**
- **免费模型**：**GLM-4.6V-Flash**、**GLM-4.7-Flash**
- [**国际站点**](https://z.ai/model-api)：已支持国际站(z.ai)切换设置。
- **搜索功能**：集成 `联网搜索MCP` 及 `Web Search API`，支持 `#zhipuWebSearch` 进行联网搜索。
    - 默认启用 `联网搜索MCP` 模式，编程套餐支持：Lite(100次/月)、Pro(1000次/月)、Max(4000次/月)。
    - 可通过设置关闭 `联网搜索MCP` 模式以使用 `Web Search API` 按次计费。

### [**MiniMax**](https://platform.minimaxi.com/login)

- [**Coding Plan 编程套餐**](https://platform.minimaxi.com/subscribe/coding-plan)：**MiniMax-M2.7**(极速版)、**MiniMax-M2.5**(极速版)、**MiniMax-M2.1**、**MiniMax-M2**
    - **搜索功能**：集成 Coding Plan 联网搜索工具，支持通过 `#minimaxWebSearch` 进行联网搜索。
    - **用量查询**：已支持状态栏显示周期剩余用量，可查看 Coding Plan 编程套餐用量信息。
    - **[国际站点](https://platform.minimax.io/subscribe/coding-plan)**：已支持国际站 Coding Plan 编程套餐使用。
- **按量计费**：**MiniMax-M2.7**(极速版)、**MiniMax-M2.5**(极速版)、**MiniMax-M2.1**(极速版)、**MiniMax-M2**

### [**MoonshotAI**](https://platform.moonshot.cn/)

- [**会员权益**](https://www.kimi.com/coding)：Kimi `会员计划` 套餐的附带的 `Kimi For Coding`，当前使用 Roo Code 发送 Anthropic 请求。
    - **搜索功能**：集成 Kimi Search 联网搜索工具，支持通过 `#kimiWebSearch` 进行联网搜索。
    - **用量查询**：已支持状态栏显示周期剩余用量，可查看套餐的剩余用量及限频重置时间。
- 预置模型：**Kimi-K2.5**
    - **余额查询**：已支持状态栏显示当前账户额度，可查看账户余额状况。

### [**DeepSeek**](https://platform.deepseek.com/)

- 预置模型：**DeepSeek-V3.2**(Reasoner)
    - **余额查询**：已支持状态栏显示当前账户额度，可查看账户余额详情。

### [**阿里云百炼**](https://bailian.console.aliyun.com/)

- [**Coding Plan**](https://www.aliyun.com/benefit/scene/codingplan)
    - 推荐模型：**Qwen3.6-Plus**、**Kimi-K2.5**、**GLM-5**、**MiniMax-M2.5**
    - 更多模型：**Qwen3.5-Plus**、**Qwen3-Max**、**Qwen3-Coder-Next**、**Qwen3-Coder-Plus**、**GLM-4.7**
- [**Token Plan**](https://www.aliyun.com/benefit/scene/tokenplan)：**Qwen3.6-Plus**、**GLM-5**、**MiniMax-M2.5**、**DeepSeek-V3.2**
- **通义千问系列**：**Qwen3.6-Plus**、**Qwen3.5-Plus**、**Qwen3.5-Flash**、**Qwen3-Max**、**Qwen3-VL-Plus**、**Qwen3-VL-Flash**、**Qwen-Plus**、**Qwen-Flash**
    - **搜索功能**：集成 [联网搜索MCP](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3023217) 工具（2000次/月），支持通过 `#bailianWebSearch` 进行联网搜索。（使用[阿里云百炼ApiKey](https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key)而非编程套餐的ApiKey）

### [**快手万擎**](https://streamlake.com/product/kat-coder) - StreamLake

- [**KwaiKAT Coding Plan**](https://streamlake.com/marketing/coding-plan)：**KAT-Coder-Pro-V2**

- **KAT-Coder系列**：**KAT-Coder-Pro-V2**(按量付费)

### [**火山方舟**](https://www.volcengine.com/product/ark)

- [**Coding Plan 套餐**](https://www.volcengine.com/activity/codingplan)：
    - 豆包模型：**Doubao-Seed-2.0-Code**、**Doubao-Seed-Code**、**Doubao-Seed-2.0-lite**、**Doubao-Seed-2.0-pro**
    - 开源模型：**GLM-5.1**、**Kimi-K2.6**、**MiniMax-M2.7**、**MiniMax-M2.5**、**Kimi-K2.5**、**GLM-4.7**、**Deepseek v3.2**
- **豆包系列**：**Doubao-Seed-2.0**(lite/mini/pro/Code)、**Doubao-Seed-1.8**、**Doubao-Seed-1.6**
- **协作奖励计划**：**GLM-4.7**、**DeepSeek-V3.2**、**DeepSeek-V3.1-terminus**

### [**腾讯云**](https://cloud.tencent.com/product/hunyuan)

- [**Coding Plan**](https://console.cloud.tencent.com/tokenhub/codingplan) / [**Token Plan**](https://console.cloud.tencent.com/tokenhub/tokenplan)：
    - 混元模型：**Tencent HY 2.0 Instruct**、**Tencent HY 2.0 Think**
    - 开源模型：**GLM-5**、**Kimi-K2.5**、**MiniMax-M2.5**、**DeepSeek-V3.2**
    - 计费模型：**GLM-5.1**、**GLM-5-Turbo**、**MiniMax-M2.7**、**Kimi-K2.6**
- **密钥配置**：腾讯云API密钥分为 [腾讯云付费模型 API Key](https://hunyuan.cloud.tencent.com/#/app/apiKeyManage)、[Coding Plan 专用 API Key](https://console.cloud.tencent.com/tokenhub/codingplan)、[Token Plan 专用 API Key](https://console.cloud.tencent.com/tokenhub/tokenplan)、[DeepSeek 专用 API Key](https://console.cloud.tencent.com/lkeap/api)、[TokenHub 付费 API Key](https://console.cloud.tencent.com/tokenhub/apikey)，需要进入正确的密钥获取界面生成密钥。

### [**Xiaomi MiMo**](https://platform.xiaomimimo.com/#/console/api-keys)

- 按量计费：**MiMo-V2.5-Pro**、**MiMo-V2.5**、**MiMo-V2-Pro**、**MiMo-V2-Omni**、**MiMo-V2-Flash**
- [**Token Plan**](https://platform.xiaomimimo.com/#/token-plan)：**MiMo-V2.5-Pro**、**MiMo-V2.5**、**MiMo-V2-Pro**、**MiMo-V2-Omni**
    - [区域集群](https://platform.xiaomimimo.com/#/docs/tokenplan/subscription?target=快速指南)：可切换选择`中国集群(cn)`、`新加坡集群(sgp)`、`欧洲集群(ams)`，按[订阅管理](https://platform.xiaomimimo.com/#/console/plan-manage)页面展示为准。
- **密钥配置**：支持设置 [Xiaomi MiMo API Key](https://platform.xiaomimimo.com/#/console/api-keys) 与 [Token Plan 专用 API Key](https://platform.xiaomimimo.com/#/console/plan-manage) 分别设置。

### [**百度千帆**](https://cloud.baidu.com/product-s/qianfan_home)

- **按量计费**：**DeepSeek-V3.2**、**GLM-5**、**GLM-5.1**、**Kimi-K2.5**、**MiniMax-M2.5**、**ERNIE-5.0**
- [**Coding Plan 编程套餐**](https://cloud.baidu.com/product/codingplan)：**DeepSeek-V3.2**、**GLM-5**、**Kimi-K2.5**、**MiniMax-M2.5**
- **密钥配置**：支持设置 [百度千帆 API Key](https://console.bce.baidu.com/qianfan/ais/console/apiKey) 与 [Coding Plan 专用 API Key](https://console.bce.baidu.com/qianfan/resource/subscribe) 分别设置。

### 实验性支持 CLI 认证提供商

> ⚠️ **风险警告**：以下 CLI 认证方式通过模拟官方 CLI 工具的调用方式来实现对应的 API 访问，**可能涉嫌滥用第三方服务条款，存在被官方检测封禁账号的风险**。请仅在确保知情并自愿承担风险的前提下使用。

<details>
<summary>展开查看 CLI 认证支持提供商说明</summary>

### [**Codex CLI**](https://chatgpt.com/codex) - OpenAI Codex

OpenAI 官方编程助手 Codex 的命令行工具，支持通过 `codex` CLI 进行身份验证（需要本地安装 `codex` CLI）。

```bash
npm install -g @openai/codex@latest
```

- **支持模型**：**GPT-5.4-mini**、**GPT-5.4**、**GPT-5.2**、**GPT-5.2-Codex**、**GPT-5.3-Codex**
- **用量查询**：已支持状态栏显示 ChatGPT 订阅周期剩余用量，可查看订阅余量信息。

### [**Gemini**](https://geminicli.com/docs/) - Gemini CLI

Google 官方 Gemini API 命令行工具，支持通过 `Gemini CLI` 进行 `Login with Google` 认证（需要本地安装 Gemini CLI）。

```bash
npm install -g @google/gemini-cli@latest
```

- **支持模型**：**Gemini 2.5 Pro**、**Gemini 2.5 Flash**、**Gemini 2.5 Flash Lite**
- **预览模型**：**Gemini 3.1 Pro (Preview)**、**Gemini 3.1 Pro (Custom Tools)**、**Gemini 3 Pro (Preview)**、**Gemini 3 Flash (Preview)**

</details>

## ⚙️ 高级配置

GCMP 支持通过 VS Code 设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

> 📝 **提示**：`settings.json` 所有参数修改会立即生效。

<details>
<summary>展开查看高级配置说明</summary>

### 通用模型参数 及 额外支持功能 配置

```json
{
    "gcmp.maxTokens": 16000, // 32-256000
    "gcmp.retry.maxAttempts": 3, // 1-5，仅对可重试错误生效
    "gcmp.zhipu.search.enableMCP": true // 启用`联网搜索MCP`（Coding Plan专属）
}
```

- `gcmp.retry.maxAttempts` 默认值为 `3`，用于控制 429、限流和临时过载类错误的最大自动重试次数。
- 当前重试延迟序列为 `1s → 3s → 6s → 10s → 15s`，达到上限后会直接抛出最后一次错误。

#### 模型 Family 配置

`family` 字段用于标识模型系列，VS Code 会根据 family 值决定模型的工具能力支持。如果未设置，将根据 `sdkMode` 自动推断：

| sdkMode                 | 默认 family                                          | 说明                      |
| ----------------------- | ---------------------------------------------------- | ------------------------- |
| `anthropic`             | `claude-sonnet-4.6`                                  | Anthropic SDK 模型        |
| `openai` / `openai-sse` | `gpt-5.2`（id/model 包含 gpt）或 `claude-sonnet-4.6` | OpenAI SDK 模型           |
| `openai-responses`      | `gpt-5.2`                                            | OpenAI Responses API 模型 |
| `gemini-sse`            | `gemini-3-pro`                                       | Gemini HTTP SSE 模型      |

**family 值对工具能力的影响**：

| family 前缀              | 编辑工具                 | 说明                               |
| ------------------------ | ------------------------ | ---------------------------------- |
| `claude-*` / `Anthropic` | `replace_string_in_file` | 高效精确的单次替换，支持多文件替换 |
| `gpt-5.*`                | `apply_patch`            | 批量差异应用，支持复杂重构         |
| `gemini-*`               | `replace_string_in_file` | 高效精确的单次替换                 |

> 参考：[VS Code Copilot Chat - chatModelCapabilities.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/common/chatModelCapabilities.ts)

**配置示例**：

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "models": [
                {
                    "id": "deepseek-v3.2",
                    "name": "Deepseek-V3.2",
                    "family": "gpt-5.2", // 可选：指定 family
                    "maxInputTokens": 128000,
                    "maxOutputTokens": 16000,
                    "capabilities": {
                        "toolCalling": true,
                        "imageInput": false
                    }
                }
            ]
        }
    }
}
```

#### 提供商配置覆盖

GCMP 支持通过 `gcmp.providerOverrides` 配置项来覆盖提供商的默认设置，包括 baseUrl、customHeader、模型配置等。

**配置示例**：

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "models": [
                {
                    "id": "deepseek-v3.2", // 增加额外模型：不在提示可选选项，但允许自定义新增
                    "name": "Deepseek-V3.2 (阿里云百炼)",
                    "tooltip": "DeepSeek-V3.2是引入DeepSeek Sparse Attention（一种稀疏注意力机制）的正式版模型，也是DeepSeek推出的首个将思考融入工具使用的模型，同时支持思考模式与非思考模式的工具调用。",
                    // "sdkMode": "openai", // 阿里云百炼已默认继承提供商设置，其他提供商模型可按需设置
                    // "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "maxInputTokens": 128000,
                    "maxOutputTokens": 16000,
                    "capabilities": {
                        "toolCalling": true,
                        "imageInput": false
                    }
                }
            ]
        }
    }
}
```

</details>

## 🔌 OpenAI / Anthropic Compatible 自定义模型支持

GCMP 提供 **OpenAI / Anthropic Compatible** Provider，用于支持任何 OpenAI 或 Anthropic 兼容的 API。通过 `gcmp.compatibleModels` 配置，您可以完全自定义模型参数，包括扩展请求参数。

1. 通过 `GCMP: Compatible Provider 设置` 命令启动配置向导。
2. 在 `settings.json` 设置中编辑 `gcmp.compatibleModels` 配置项。

<details>
<summary>展开查看自定义模型配置说明</summary>

### 自定义模型内置已知提供商ID及显示名称列表

> 聚合转发类型的提供商可提供内置特殊适配，不作为单一提供商提供。<br/>
> 若需要内置或特殊适配的请通过 Issue 提供相关信息。

| 提供商ID        | 提供商名称                                                | 提供商描述      | 余额查询     |
| --------------- | --------------------------------------------------------- | --------------- | ------------ |
| **aiping**      | [**AI Ping**](https://aiping.cn/#?invitation_code=EBQQKW) |                 | 用户账户余额 |
| **aihubmix**    | [**AIHubMix**](https://aihubmix.com/?aff=xb8N)            | 可立享 10% 优惠 | ApiKey余额   |
| **openrouter**  | [**OpenRouter**](https://openrouter.ai/)                  |                 | 用户账户余额 |
| **siliconflow** | [**硅基流动**](https://cloud.siliconflow.cn/i/tQkcsZbJ)   |                 | 用户账户余额 |

**配置示例**：

```json
{
    "gcmp.compatibleModels": [
        {
            "id": "glm-4.6",
            "name": "GLM-4.6",
            "provider": "zhipu",
            "model": "glm-4.6",
            "sdkMode": "openai",
            "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
            // "sdkMode": "anthropic",
            // "baseUrl": "https://open.bigmodel.cn/api/anthropic",
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096,
            "capabilities": {
                "toolCalling": true, // Agent模式下模型必须支持工具调用
                "imageInput": false
            },
            // customHeader 和 extraBody 可按需设置
            "customHeader": {
                "X-Model-Specific": "value",
                "X-Custom-Key": "${APIKEY}"
            },
            "extraBody": {
                "temperature": 0.1,
                "top_p": 0.9,
                // "top_p": null, // 部分提供商不支持同时设置 temperature 和 top_p
                "thinking": { "type": "disabled" }
            }
        }
    ]
}
```

### 实验性功能：`sdkMode`（OpenAI Responses / Gemini SSE）

`gcmp.compatibleModels[*].sdkMode` 用于指定兼容层的请求/流式解析方式。除 `openai` / `anthropic` 标准模式外，以下两项为**实验性**能力：

- `openai-responses`：OpenAI Responses API 模式（实验性）
    - 使用 OpenAI SDK 的 Responses API（`/responses`）进行请求与流式处理。
    - 参数：默认不传递 `max_output_tokens`，若需设置通过 `extraBody` 单独设置
    - Codex：默认通过请求头传递 `conversation_id`、`session_id`，请求体传递 `prompt_cache_key`（火山方舟传递 `previous_response_id` 除外）。
    - 注意：并非所有 OpenAI 兼容服务都实现 `/responses`；若报 404/不兼容，请切回 `openai` 或 `openai-sse`。
    - `useInstructions`（仅对 `openai-responses` 生效）：是否使用 Responses API 的 `instructions` 参数传递系统指令。
        - `false`：用“用户消息”承载系统指令（默认，兼容性更好）
        - `true`：用 `instructions` 传递系统指令（部分网关可能不支持）

- `gemini-sse`：Gemini HTTP SSE 模式（实验性）
    - 使用纯 HTTP + SSE（`data:`）/ JSON 行流解析，不依赖 Google SDK，主要用于兼容第三方 Gemini 网关。
    - 适用：你的网关对外暴露 Gemini `:streamGenerateContent` 风格接口（通常需要 `alt=sse`）。
    - 工具参数会自动做 Schema 清理与 Gemini 方言转换，兼容 `const`、`$ref`、可空联合类型以及空对象 / 空数组等常见写法。

</details>

## 💡 FIM / NES 内联补全建议功能

- **FIM**：根据上下文预测并补全光标处缺失的代码，适合单行/短片段补全。
- **NES**：基于编辑上下文提供智能代码建议，支持多行代码生成。

> **使用前必读**：需先在对话模型中配置并验证 ApiKey；在输出面板选择 `GitHub Copilot Inline Completion via GCMP` 可查看调试信息。接入的是通用大模型，**未针对代码补全专门训练**，效果可能不及 Copilot 原生 Tab 补全。

<details>
<summary>展开查看详细配置说明</summary>

### FIM / NES 内联补全建议模型配置

FIM 和 NES 补全都使用单独的模型配置，可以分别通过 `gcmp.fimCompletion.modelConfig` 和 `gcmp.nesCompletion.modelConfig` 进行设置。

- **启用 FIM 补全模式**（推荐 DeepSeek、Qwen 等支持 FIM 的模型）：
    - 已测试支持 `DeepSeek`、`硅基流动`，特殊支持 `阿里云百炼`。

```json
{
    "gcmp.fimCompletion.enabled": true, // 启用 FIM 补全功能
    "gcmp.fimCompletion.debounceMs": 500, // 自动触发补全的防抖延迟
    "gcmp.fimCompletion.timeoutMs": 5000, // FIM 补全的请求超时时间
    "gcmp.fimCompletion.modelConfig": {
        "provider": "deepseek", // 提供商ID，其他请先添加 OpenAI Compatible 自定义模型 provider 并设置 ApiKey
        "baseUrl": "https://api.deepseek.com/beta", // ⚠️ DeepSeek FIM 必须使用 beta 端点才支持
        // "baseUrl": "https://api.siliconflow.cn/v1", // 硅基流动(provider:`siliconflow`)
        // "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", // 阿里云百炼(provider:`dashscope`)
        "model": "deepseek-chat",
        "maxTokens": 100
        // "extraBody": { "top_p": 0.9 }
    }
}
```

- **启用 NES 手动补全模式**：

````json
{
    "gcmp.nesCompletion.enabled": true, // 启用 NES 补全功能
    "gcmp.nesCompletion.debounceMs": 500, // 自动触发补全的防抖延迟
    "gcmp.nesCompletion.timeoutMs": 10000, // NES 补全请求超时时间
    "gcmp.nesCompletion.manualOnly": true, // 启用手动 `Alt+/` 快捷键触发代码补全提示
    "gcmp.nesCompletion.modelConfig": {
        "provider": "zhipu", // 提供商ID，其他请先添加 OpenAI Compatible 自定义模型 provider 并设置 ApiKey
        "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4", // OpenAI Chat Completion Endpoint 的 BaseUrl 地址
        "model": "glm-4.6", // 推荐使用性能较好的模型，留意日志输出是否包含 ``` markdown 代码符
        "maxTokens": 200,
        "extraBody": {
            // GLM-4.6 默认启用思考，补全场景建议关闭思考以加快响应
            "thinking": { "type": "disabled" }
        }
    }
}
````

- **混合使用 FIM + NES 补全模式**：

> - **自动触发 + manualOnly: false**：根据光标位置智能选择提供者
>     - 光标在行尾 → 使用 FIM（适合补全当前行）
>     - 光标不在行尾 → 使用 NES（适合编辑代码中间部分）
>     - 如果使用 NES 提供无结果或补全无意义，则自动回退到 FIM
> - **自动触发 + manualOnly: true**：仅发起 FIM 请求（NES 需手动触发）
> - **手动触发**（按 `Alt+/`）：直接调用 NES，不发起 FIM
> - **模式切换**（按 `Shift+Alt+/`）：在自动/手动间切换（仅影响 NES）

#### [MistralAI Coding](https://console.mistral.ai/codestral) FIM 配置示例

```json
{
    "gcmp.compatibleModels": [
        {
            "id": "codestral-latest",
            "name": "codestral-latest",
            "provider": "mistral",
            "baseUrl": "https://codestral.mistral.ai/v1",
            "sdkMode": "openai",
            "maxInputTokens": 32000,
            "maxOutputTokens": 4096,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
            }
        }
    ],
    "gcmp.fimCompletion.enabled": true,
    "gcmp.fimCompletion.debounceMs": 500,
    "gcmp.fimCompletion.timeoutMs": 5000,
    "gcmp.fimCompletion.modelConfig": {
        "provider": "mistral",
        "baseUrl": "https://codestral.mistral.ai/v1/fim",
        "model": "codestral-latest",
        "extraBody": { "code_annotations": null },
        "maxTokens": 100
    }
}
```

### 快捷键与操作

| 快捷键        | 操作说明                     |
| ------------- | ---------------------------- |
| `Alt+/`       | 手动触发补全建议（NES 模式） |
| `Shift+Alt+/` | 切换 NES 手动触发模式        |

</details>

## 🪟 上下文窗口占用比例状态栏

GCMP 提供上下文窗口占用比例状态栏显示功能，帮助您实时监控当前会话的上下文窗口使用情况。

<details>
<summary>展开主要特性说明</summary>

### 主要特性

- **实时监控**：状态栏实时显示当前会话的上下文窗口占用比例
- **详细统计**：悬停状态栏可查看详细的上下文占用信息，包括：
    - **系统提示**：系统提示词占用的 token 数量
    - **可用工具**：工具及MCP定义占用的 token 数量
    - **环境信息**：编辑器环境信息占用的 token 数量
    - **压缩消息**：经过压缩的历史消息占用的 token 数量
    - **历史消息**：历史对话消息占用的 token 数量
    - **思考内容**：会话思考过程占用的 token 数量
    - **本轮图片**：当前会话图片附件的 token 数量
    - **本轮消息**：当前会话消息占用的 token 数量

</details>

## 📊 Token 消耗统计功能

GCMP 内置了完整的 Token 消耗统计功能，帮助您追踪和管理 AI 模型的使用情况。

<details>
<summary>展开查看详细功能说明</summary>

### 主要特性

- **持久化记录**：基于文件系统的日志记录，无存储限制，支持长期数据保存
- **用量统计**：记录每次 API 请求的模型和用量信息，包括：
    - 模型信息（提供商、模型 ID、模型名称）
    - Token 用量（预估输入、实际输入、输出、缓存、推理等）
    - 请求状态（预估/完成/失败）
- **多维度统计**：按日期、提供商、模型、小时等多维度查看统计数据
    - **小时统计详情**：支持按小时、提供商、模型三层嵌套显示
        - ⏰ 小时级别：显示该小时的总计数据
        - 📦 提供商级别：显示该提供商在该小时的汇总数据
        - ├─ 模型级别：显示该模型在该小时的详细数据
        - 提供商和模型按请求数降序排列，无有效请求的提供商和模型不显示
- **实时状态栏**：状态栏实时显示今日 Token 用量，30秒自动刷新
- **可视化视图**：WebView 详细视图支持查看历史记录、分页显示请求记录

### 使用方式

- **查看统计**：点击状态栏的 Token 用量显示，或通过命令面板执行 `GCMP: 查看今日 Token 消耗统计详情` 命令
- **历史记录**：在详细视图中可查看任意日期的统计记录
- **数据管理**：支持打开日志存储目录进行手动管理

### 配置选项

```json
{
    "gcmp.usages.retentionDays": 100 // 历史数据保留天数（0表示永久保留）
}
```

</details>

## 📝 Commit 生成提交消息功能

GCMP 支持在提交前自动读取当前仓库的改动（已暂存/未暂存/新文件），提取关键 diff 片段并结合相关历史提交与仓库整体提交风格（auto 模式下）来生成更贴合你项目习惯的提交信息。

<details>
<summary>展开查看详细使用说明</summary>

### 系统要求

- **vscode.git 扩展**：该功能依赖 VS Code 内置的 `vscode.git` 扩展来访问 Git 仓库信息
    - 扩展会自动检测 Git 可用性，当 Git 不可用时相关按钮将自动隐藏
    - 如果你的环境中禁用了 `vscode.git` 扩展，Commit 消息生成功能将不可用

### 使用入口：Git仓库管理视图

- 仓库标题栏按钮：`生成提交消息`
- 更改分组栏按钮：
    - 在“暂存的更改”上生成：`生成提交消息 - 暂存的更改`
    - 在“更改”上生成 `生成提交消息 - 未暂存的更改`

### 生成范围说明（staged / working tree）

- `生成提交消息`：默认行为，**同时分析 staged + working tree**（tracked + untracked）。
- `生成提交消息 - 暂存的更改`：仅分析 **staged**，适合“分步提交/拆分提交”。
- `生成提交消息 - 未暂存的更改`：仅分析 **working tree**（tracked + untracked），不包含 staged。

> 多仓库工作区：如果当前工作区包含多个 Git 仓库，GCMP 会尝试根据你点击的 SCM 区域推断仓库；无法推断时会弹出仓库选择。

### 模型选择与配置

该功能基于 **VS Code Language Model API** 调用模型。

- 第一次使用或未配置模型时，会自动引导选择模型（也可手动运行 `GCMP: 选择 Commit 消息生成模型`）。
- 相关配置项：

```json
{
    "gcmp.commit.language": "chinese", // 生成语言：chinese / english（auto 模式语言不明确时的回退值）
    "gcmp.commit.format": "auto", // 提交消息格式：auto(默认) / 见下方 format 说明
    "gcmp.commit.customInstructions": "", // 自定义指令（仅当 format=custom 时生效）
    "gcmp.commit.model": {
        "provider": "zhipu", // 生成模型的提供商（providerKey，例如 zhipu / minimax / compatible）
        "model": "glm-4.6" // 生成模型的 ID（对应 VS Code Language Model 的 model.id）
    }
}
```

### `gcmp.commit.format` 格式说明与示例

> 说明：以下示例仅用于展示格式形态；实际内容会根据你的 diff 自动生成。

- `auto`：自动推断（会参考仓库历史的语言/风格；不明确时回退为 `plain` + `gcmp.commit.language`），默认推荐。

- `plain`：简洁一句话，不含 type/scope/emoji（适合快速提交）。

- `custom`：完全由你的自定义指令控制（`gcmp.commit.customInstructions`）。

- `conventional`：Conventional Commits（可带 scope，常见写法是“标题 + 可选正文要点”）。

```text
feat(commit): 新增提交消息生成

- 支持 staged / 未暂存分别生成
- 自动补充相关历史提交作为参考
```

- `angular`：Angular 风格（`type(scope): summary`，语义上接近 conventional）。

```text
feat(commit): 新增 SCM 入口

- 在仓库标题栏与更改分组栏增加入口
```

- `karma`：Karma 风格（偏“单行”，保持短小）。

```text
fix(commit): 修复多仓库选择
```

- `semantic`：语义化 `type: message`（不带 scope；也可以带正文要点）。

```text
feat: 新增提交消息生成

- 自动识别本次变更的关键 diff
```

- `emoji`：Emoji 前缀（不带 type）。

```text
✨ 新增提交消息生成
```

- `emojiKarma`：Emoji + Karma（emoji + `type(scope): msg`）。

```text
✨ feat(commit): 新增提交消息生成

- 更贴合仓库既有提交习惯
```

- `google`：Google 风格（`Type: Description`）。

```text
Feat: 新增提交消息生成

- 支持按仓库风格自动选择语言与格式
```

- `atom`：Atom 风格（`:emoji: message`）。

```text
:sparkles: 新增提交消息生成
```

</details>

## 🤝 贡献指南

我们欢迎社区贡献！无论是报告bug、提出功能建议还是提交代码，都能帮助这个项目变得更好。

### 开发环境设置

```bash
# 克隆项目
git clone https://github.com/VicBilibily/GCMP.git
cd GCMP
# 安装依赖
npm install
# 在 VsCode 打开后按下 F5 开始扩展调试
```

## 💰 赞助

如果您觉得这个项目对您有帮助，欢迎通过 [查看赞助二维码](donate.jpg) 支持项目的持续开发。

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。
