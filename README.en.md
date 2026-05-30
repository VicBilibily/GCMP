# GCMP - Multi-Provider AI Chat Models for GitHub Copilot

English | **[中文](README.md)**

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![License](https://img.shields.io/badge/License-MIT-orange)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

Integrates leading Chinese AI model providers into GitHub Copilot Chat, giving developers richer, more locally-tuned AI coding assistant options.
Currently supports **ZhipuAI**, **MiniMax**, **MoonshotAI**, **DeepSeek**, **Alibaba Cloud DashScope**, **StreamLake**, **Volcengine**, **Tencent Cloud**, **Xiaomi MiMo**, and **Baidu Qianfan** as native providers.
Additionally, the extension supports any OpenAI or Anthropic API-compatible models via the **Compatible Provider**.

## 🚀 Quick Start

### 1. Install the Extension

Search for `GCMP` in the VS Code Extension Marketplace, or use the identifier: [`vicanent.gcmp`](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)

### 2. Get Started

1. Open the `GitHub Copilot Chat` panel in VS Code
2. Click `Manage Models` at the bottom of the model selector, then choose a provider from the list
3. On first use, you'll be prompted to set an API Key. Complete the configuration and return to the model selector to enable the model
4. Select your target model in the model selector and start chatting with the AI assistant

## 🤖 Built-in AI Model Providers

> This extension only includes first-tier providers with self-developed models (e.g., major cloud vendors with model R&D capabilities). For third-party model access, use the "OpenAI / Anthropic Compatible" mode.

### [**ZhipuAI**](https://bigmodel.cn/)

- [**Coding Plan**](https://bigmodel.cn/glm-coding): **GLM-5.1**, **GLM-5V-Turbo**, **GLM-5-Turbo**, **GLM-4.7**, **GLM-4.6**, **GLM-4.6V**, **GLM-4.5-Air**
    - **Usage tracking**: Status bar displays remaining cycle quota for GLM Coding Plan.
- **PayGo**: **GLM-5.1** (HighSpeed), **GLM-5V-Turbo**, **GLM-5-Turbo**, **GLM-5**, **GLM-4.7**, **GLM-4.7-FlashX**, **GLM-4.6**, **GLM-4.6V**, **GLM-4.5-Air**
- **Free models**: **GLM-4.6V-Flash**, **GLM-4.7-Flash**
- [**International site**](https://z.ai/model-api): Supports switching to the international site (z.ai).
- **Search**: Integrated `Web Search MCP` and `Web Search API`, supports `#zhipuWebSearch` for web searches.
    - `Web Search MCP` mode is enabled by default. Coding Plan includes: Lite (100/month), Pro (1,000/month), Max (4,000/month).
    - Disable MCP mode in settings to use the `Web Search API` pay-per-request billing.

### [**MiniMax**](https://platform.minimaxi.com/login)

- [**Coding Plan**](https://platform.minimaxi.com/subscribe/coding-plan): **MiniMax-M2.7** (HighSpeed), **MiniMax-M2.5** (HighSpeed), **MiniMax-M2.1**, **MiniMax-M2**
    - **Search**: Integrated Coding Plan web search tool, supports `#minimaxWebSearch`.
    - **Image recognition**: Integrated Coding Plan image understanding MCP — paste images or screenshots directly for Agent interaction.
    - **Usage tracking**: Status bar displays remaining Coding Plan quota.
    - [**International site**](https://platform.minimax.io/subscribe/coding-plan): Supports international site Coding Plan.
- **PayGo**: **MiniMax-M2.7** (HighSpeed), **MiniMax-M2.5** (HighSpeed), **MiniMax-M2.1** (HighSpeed), **MiniMax-M2**

### [**MoonshotAI**](https://platform.moonshot.cn/)

- [**Membership**](https://www.kimi.com/coding): Kimi membership plan includes `Kimi For Coding`.
    - **Search**: Integrated Kimi Search web search tool, supports `#kimiWebSearch`.
    - **Usage tracking**: Status bar displays remaining quota and rate-limit reset time.
- Preset models: **Kimi-K2.5**
    - **Balance query**: Status bar displays current account balance.

### [**DeepSeek**](https://platform.deepseek.com/)

- Preset models: **DeepSeek-V4-Flash** (fast mode), **DeepSeek-V4-Pro** (expert mode)
    - **Balance query**: Status bar displays current account balance.

### [**Alibaba Cloud DashScope**](https://bailian.console.aliyun.com/) - AliDashScope

- [**Coding Plan**](https://www.aliyun.com/benefit/scene/codingplan)
    - Recommended: **Qwen3.6-Plus**, **Kimi-K2.5**, **GLM-5**, **MiniMax-M2.5**
    - More: **Qwen3.5-Plus**, **Qwen3-Max**, **Qwen3-Coder-Next**, **Qwen3-Coder-Plus**, **GLM-4.7**
- [**Token Plan**](https://www.aliyun.com/benefit/scene/tokenplan): **Qwen3.7-Max**, **Qwen3.6-Plus**, **Qwen3.6-Flash**, **GLM-5.1**, **GLM-5**, **Kimi-K2.6**, **Kimi-K2.5**, **MiniMax-M2.5**, **DeepSeek-V4-Pro**, **DeepSeek-V4-Flash**, **DeepSeek-V3.2**
- **Qwen series**: **Qwen3.7-Max**, **Qwen3.6-Max**, **Qwen3.6-Plus**, **Qwen3.6-Flash**, **Qwen3.5-Plus**, **Qwen3.5-Flash**, **Qwen3-Max**, **Qwen3-VL-Plus**, **Qwen3-VL-Flash**, **Qwen-Plus**, **Qwen-Flash**
- **DeepSeek-V4**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**
- **Search**: Integrated [Web Search MCP](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3023217) tool (2,000/month), supports `#bailianWebSearch`. (Uses [DashScope API Key](https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key), not the Coding Plan API Key)

### [**StreamLake**](https://streamlake.com/product/kat-coder) - Kwai WanQing

- [**KwaiKAT Coding Plan**](https://streamlake.com/marketing/coding-plan): **KAT-Coder-Pro-V2**
- **KAT-Coder series**: **KAT-Coder-Pro-V2** (PayGo)

### [**Volcengine**](https://www.volcengine.com/product/ark)

- [**Coding Plan**](https://www.volcengine.com/activity/codingplan):
    - Doubao models: **Doubao-Seed-2.0-Code**, **Doubao-Seed-Code**, **Doubao-Seed-2.0-lite**, **Doubao-Seed-2.0-pro**
    - Open-source models: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **GLM-5.1**, **Kimi-K2.6**, **MiniMax-M2.7**, **MiniMax-M2.5**, **Kimi-K2.5**, **GLM-4.7**, **DeepSeek-V3.2**
- [**Agent Plan**](https://www.volcengine.com/activity/agentplan):
    - Doubao models: **Doubao-Seed-2.0** (Code/pro/lite/mini)
    - Open-source models: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **GLM-5.1**, **MiniMax-M2.7**, **Kimi-K2.6**, **DeepSeek-V3.2**
- **Doubao series**: **Doubao-Seed-2.0** (lite/mini/pro/Code), **Doubao-Seed-1.8**
- **Collaboration rewards**: **GLM-4.7**, **DeepSeek-V3.2**
- **PayGo**: **DeepSeek-V4-Flash-260425**, **DeepSeek-V4-Pro-260425**
- **Key configuration**: Supports separate [Coding Plan API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) and [Agent Plan API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan). Setup wizard guides you through plan type selection.

### [**Tencent Cloud**](https://cloud.tencent.com/product/hunyuan)

- [**Coding Plan**](https://console.cloud.tencent.com/tokenhub/codingplan)
    - Hunyuan models: **Tencent HY 2.0 Instruct**, **Tencent HY 2.0 Think**
    - Open-source models: **GLM-5**, **Kimi-K2.5**, **MiniMax-M2.5**, **DeepSeek-V3.2**
- [**Token Plan**](https://console.cloud.tencent.com/tokenhub/tokenplan): **HY 3 Preview**, **GLM-5.1**, **GLM-5**, **Kimi-K2.5**, **MiniMax-M2.7**, **MiniMax-M2.5**
- [**TokenHub**](https://console.cloud.tencent.com/tokenhub/models): **HY 3 Preview**, **GLM-5.1**, **GLM-5-Turbo**, **GLM-5**, **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **DeepSeek-V3.2**, **Kimi-K2.6**, **Kimi-K2.5**, **MiniMax-M2.7**, **MiniMax-M2.5**
- **Key configuration**: Tencent Cloud API keys are categorized into [paid model API Key](https://hunyuan.cloud.tencent.com/#/app/apiKeyManage), [Coding Plan API Key](https://console.cloud.tencent.com/tokenhub/codingplan), [Token Plan API Key](https://console.cloud.tencent.com/tokenhub/tokenplan), [DeepSeek API Key](https://console.cloud.tencent.com/lkeap/api), and [TokenHub API Key](https://console.cloud.tencent.com/tokenhub/apikey). Each must be generated from the correct key management page.

### [**Xiaomi MiMo**](https://platform.xiaomimimo.com/#/console/api-keys)

- **PayGo**: **MiMo-V2.5-Pro**, **MiMo-V2.5**, **MiMo-V2-Flash**
- [**Token Plan**](https://platform.xiaomimimo.com/#/token-plan): **MiMo-V2.5-Pro**, **MiMo-V2.5**
    - [Regional clusters](https://platform.xiaomimimo.com/#/docs/tokenplan/subscription?target=快速指南): Switch between `China (cn)`, `Singapore (sgp)`, and `Europe (ams)` clusters. Refer to the [subscription management](https://platform.xiaomimimo.com/#/console/plan-manage) page for details.
- **Key configuration**: Supports separate [Xiaomi MiMo API Key](https://platform.xiaomimimo.com/#/console/api-keys) and [Token Plan API Key](https://platform.xiaomimimo.com/#/console/plan-manage).

### [**Baidu Qianfan**](https://cloud.baidu.com/product-s/qianfan_home)

- **PayGo**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **DeepSeek-V3.2**, **GLM-5**, **GLM-5.1**, **Kimi-K2.5**, **MiniMax-M2.5**, **ERNIE-5.1**, **ERNIE-5.0**
- [**Coding Plan**](https://cloud.baidu.com/product/codingplan): **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **GLM-5.1**, **DeepSeek-V3.2**, **GLM-5**, **Kimi-K2.5**, **MiniMax-M2.5**
- **Key configuration**: Supports separate [Baidu Qianfan API Key](https://console.bce.baidu.com/qianfan/ais/console/apiKey) and [Coding Plan API Key](https://console.bce.baidu.com/qianfan/resource/subscribe).

### Experimental CLI Authentication Providers

> ⚠️ **Risk Warning**: The following CLI authentication methods simulate official CLI tool calls to access the corresponding APIs. **This may constitute a violation of third-party terms of service and carries the risk of account bans.** Use only if you are fully informed and voluntarily accept the risks.

<details>
<summary>Click to expand CLI authentication provider details</summary>

### [**Codex CLI**](https://chatgpt.com/codex) - OpenAI Codex

OpenAI's official coding assistant Codex CLI tool. Supports authentication via the `codex` CLI (requires local installation).

```bash
npm install -g @openai/codex@latest
```

- **Supported models**: **GPT-5.5**, **GPT-5.4-mini**, **GPT-5.4**
- **Usage tracking**: Status bar displays remaining ChatGPT subscription cycle quota.

### [**Gemini**](https://geminicli.com/docs/) - Gemini CLI

Google's official Gemini API CLI tool. Supports `Login with Google` authentication via Gemini CLI (requires local installation).

```bash
npm install -g @google/gemini-cli@latest
```

- **Supported models**: **Gemini 2.5 Pro**, **Gemini 2.5 Flash**, **Gemini 2.5 Flash Lite**
- **Preview models**: **Gemini 3.1 Pro (Preview)**, **Gemini 3.1 Pro (Custom Tools)**, **Gemini 3 Pro (Preview)**, **Gemini 3 Flash (Preview)**

</details>

## ⚙️ Advanced Configuration

GCMP supports customizing AI model behavior parameters through VS Code settings for a more personalized experience.

> 📝 **Note**: All `settings.json` parameter changes take effect immediately.

<details>
<summary>Click to expand advanced configuration details</summary>

### General Model Parameters & Extra Features

```json
{
    "gcmp.maxTokens": 32000, // 32-256000
    "gcmp.retry.maxAttempts": 3, // 1-5, only effective for retryable errors
    "gcmp.zhipu.search.enableMCP": true // Enable Web Search MCP (Coding Plan exclusive)
}
```

- `gcmp.retry.maxAttempts` defaults to `3`, controlling the maximum automatic retry count for 429, rate-limit, and temporary overload errors.
- Current retry delay sequence: `1s → 3s → 6s → 10s → 15s`. Once the limit is reached, the last error is thrown directly.

**Configuration example**:

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "models": [
                {
                    "id": "deepseek-v3.2",
                    "name": "Deepseek-V3.2",
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

#### Provider Configuration Overrides

GCMP supports overriding provider defaults (including baseUrl, customHeader, model config, etc.) through the `gcmp.providerOverrides` setting.

**Configuration example**:

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "models": [
                {
                    "id": "deepseek-v3.2", // Add extra model: not in suggestions, but allows custom additions
                    "name": "Deepseek-V3.2 (DashScope)",
                    "tooltip": "DeepSeek-V3.2 introduces DeepSeek Sparse Attention and is the first DeepSeek model to integrate thinking into tool usage.",
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

## 🔌 Compatible Custom Model Support

GCMP provides a **Compatible Provider** for any OpenAI or Anthropic API-compatible service. Through the `gcmp.compatibleModels` setting, you can fully customize model parameters, including extended request parameters.

1. Launch the configuration wizard via the `GCMP: Compatible Provider Settings` command.
2. Edit the `gcmp.compatibleModels` setting in `settings.json`.

<details>
<summary>Click to expand custom model configuration details</summary>

### Built-in Known Provider IDs and Display Names

> Aggregation/relay providers may receive built-in special adaptations and are not listed as standalone providers.<br/>
> If you need built-in or special adaptation support, please submit an Issue with relevant information.

| Provider ID     | Provider Name                                              | Description | Balance Query   |
| --------------- | ---------------------------------------------------------- | ----------- | --------------- |
| **aiping**      | [**AI Ping**](https://aiping.cn/#?invitation_code=EBQQKW)  |             | Account balance |
| **aihubmix**    | [**AIHubMix**](https://aihubmix.com/?aff=xb8N)             | 10% off     | API Key balance |
| **openrouter**  | [**OpenRouter**](https://openrouter.ai/)                   |             | Account balance |
| **siliconflow** | [**SiliconFlow**](https://cloud.siliconflow.cn/i/tQkcsZbJ) |             | Account balance |

**Configuration example**:

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
                "toolCalling": true, // Model must support tool calling in Agent mode
                "imageInput": false
            },
            // customHeader and extraBody are optional
            "customHeader": {
                "X-Model-Specific": "value",
                "X-Custom-Key": "${APIKEY}"
            },
            "extraBody": {
                "temperature": 0.1,
                "top_p": 0.9,
                // "top_p": null, // Some providers don't support temperature + top_p simultaneously
                "thinking": { "type": "disabled" }
            }
        }
    ]
}
```

### Experimental: `sdkMode` (OpenAI Responses / Gemini SSE)

`gcmp.compatibleModels[*].sdkMode` specifies the compatible layer's request/streaming parsing mode. Beyond the standard `openai` / `anthropic` modes, the following are **experimental**:

- `openai-responses`: OpenAI Responses API mode (experimental)
    - Uses the OpenAI SDK's Responses API (`/responses`) for request and streaming processing.
    - Parameters: `max_output_tokens` is not sent by default; set via `extraBody` if needed.
    - Codex: Sends `conversation_id` and `session_id` via request headers by default, and `prompt_cache_key` in the request body (except Volcengine which sends `previous_response_id`).
    - Note: Not all OpenAI-compatible services implement `/responses`. If you get 404 or compatibility errors, switch back to `openai` or `openai-sse`.
    - `useInstructions` (only for `openai-responses`): Whether to use the Responses API's `instructions` parameter for system prompts.
        - `false`: System prompts sent as "user messages" (default, better compatibility)
        - `true`: System prompts sent via `instructions` (some gateways may not support this)

- `gemini-sse`: Gemini HTTP SSE mode (experimental)
    - Uses pure HTTP + SSE (`data:`) / JSON line stream parsing without the Google SDK, primarily for third-party Gemini gateway compatibility.
    - Suitable when your gateway exposes a Gemini `:streamGenerateContent` style interface (typically requires `alt=sse`).
    - Tool parameters are automatically cleaned and converted to Gemini dialect, supporting `const`, `$ref`, nullable union types, and empty object/array patterns.

</details>

## 💡 FIM / NES Inline Completion Suggestions

- **FIM**: Predicts and completes missing code at the cursor position based on context, suitable for single-line/short snippet completion.
- **NES**: Provides intelligent code suggestions based on editing context, supporting multi-line code generation.

> **Important**: An API Key must be configured and verified in a chat model first. Select `GitHub Copilot Inline Completion via GCMP` in the Output panel to view debug info. These use general-purpose LLMs **not specifically trained for code completion**, so results may not match Copilot's native Tab completion.

<details>
<summary>Click to expand detailed configuration</summary>

### FIM / NES Inline Completion Model Configuration

FIM and NES completions use separate model configurations, configurable via `gcmp.fimCompletion.modelConfig` and `gcmp.nesCompletion.modelConfig`.

- **Enable FIM completion mode** (recommended: DeepSeek, Qwen, and other FIM-supporting models):
    - Tested with `DeepSeek`, `SiliconFlow`, and special support for `Alibaba Cloud DashScope`.

```json
{
    "gcmp.fimCompletion.enabled": true, // Enable FIM completion
    "gcmp.fimCompletion.debounceMs": 500, // Debounce delay for auto-triggered completion
    "gcmp.fimCompletion.timeoutMs": 5000, // FIM completion request timeout
    "gcmp.fimCompletion.modelConfig": {
        "provider": "deepseek", // Provider ID; for others, add an OpenAI Compatible custom model provider and set API Key first
        "baseUrl": "https://api.deepseek.com/beta", // ⚠️ DeepSeek FIM requires the beta endpoint
        // "baseUrl": "https://api.siliconflow.cn/v1", // SiliconFlow (provider: `siliconflow`)
        // "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", // DashScope (provider: `dashscope`)
        "model": "deepseek-chat",
        "maxTokens": 100
        // "extraBody": { "top_p": 0.9 }
    }
}
```

- **Enable NES manual completion mode**:

````json
{
    "gcmp.nesCompletion.enabled": true, // Enable NES completion
    "gcmp.nesCompletion.debounceMs": 500, // Debounce delay for auto-triggered completion
    "gcmp.nesCompletion.timeoutMs": 10000, // NES completion request timeout
    "gcmp.nesCompletion.manualOnly": true, // Enable manual `Alt+/` shortcut trigger
    "gcmp.nesCompletion.modelConfig": {
        "provider": "zhipu", // Provider ID; for others, add an OpenAI Compatible custom model provider and set API Key first
        "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4", // OpenAI Chat Completion Endpoint BaseUrl
        "model": "glm-4.6", // Recommended: use a performant model; check logs for ``` markdown code fences
        "maxTokens": 200,
        "extraBody": {
            // GLM-4.6 enables thinking by default; disable for faster completion responses
            "thinking": { "type": "disabled" }
        }
    }
}
````

- **Mixed FIM + NES completion mode**:

> - **Auto-trigger + manualOnly: false**: Intelligently selects provider based on cursor position
>     - Cursor at end of line → FIM (suitable for completing current line)
>     - Cursor not at end of line → NES (suitable for mid-line editing)
>     - If NES returns no result or meaningless completion, falls back to FIM
> - **Auto-trigger + manualOnly: true**: Only initiates FIM requests (NES requires manual trigger)
> - **Manual trigger** (press `Alt+/`): Directly invokes NES, no FIM request
> - **Mode toggle** (press `Shift+Alt+/`): Switch between auto/manual (affects NES only)

#### [MistralAI Coding](https://console.mistral.ai/codestral) FIM Configuration Example

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

### Keyboard Shortcuts

| Shortcut      | Action                                 |
| ------------- | -------------------------------------- |
| `Alt+/`       | Manually trigger completion (NES mode) |
| `Shift+Alt+/` | Toggle NES manual trigger mode         |

</details>

## 🪟 Context Window Usage Status Bar

GCMP provides a status bar indicator showing the current session's context window usage ratio.

<details>
<summary>Click to expand feature details</summary>

### Key Features

- **Real-time monitoring**: Status bar displays the current session's context window usage ratio in real time
- **Detailed statistics**: Hover over the status bar to view detailed context usage, including:
    - **System prompt**: Tokens consumed by the system prompt
    - **Available tools**: Tokens consumed by tool and MCP definitions
    - **Environment info**: Tokens consumed by editor environment information
    - **Compressed messages**: Tokens consumed by compressed historical messages
    - **History messages**: Tokens consumed by historical conversation messages
    - **Thinking content**: Tokens consumed by session thinking process
    - **Current images**: Tokens consumed by current session image attachments
    - **Current messages**: Tokens consumed by current session messages

</details>

## 📊 Token Usage Statistics

GCMP includes comprehensive token usage tracking to help you monitor and manage AI model consumption.

<details>
<summary>Click to expand feature details</summary>

### Key Features

- **Persistent logging**: File-based logging with no storage limits, supporting long-term data retention
- **Usage tracking**: Records model and usage information for each API request, including:
    - Model info (provider, model ID, model name)
    - Token usage (estimated input, actual input, output, cache, reasoning, etc.)
    - Request status (estimated/completed/failed)
- **Multi-dimensional statistics**: View data by date, provider, model, hour, etc.
    - **Hourly detail**: Supports three-level nesting by hour, provider, and model
        - ⏰ Hour level: Total data for that hour
        - 📦 Provider level: Aggregated data for that provider in that hour
        - ├─ Model level: Detailed data for that model in that hour
        - Providers and models sorted by request count descending; those with no valid requests are hidden
- **Real-time status bar**: Status bar displays today's token usage, auto-refreshing every 30 seconds
- **Visual view**: WebView detail view supports viewing history and paginated request records

### How to Use

- **View statistics**: Click the token usage indicator in the status bar, or run `GCMP: View Today's Token Usage Details` from the command palette
- **History**: View statistics for any date in the detail view
- **Data management**: Open the log storage directory for manual management

### Configuration

```json
{
    "gcmp.usages.retentionDays": 100 // Number of days to retain historical data (0 = permanent)
}
```

</details>

## 📝 Commit Message Generation

GCMP supports automatically reading repository changes (staged/unstaged/new files) before committing, extracting key diff snippets, and combining relevant historical commits with the repository's overall commit style (in auto mode) to generate commit messages that match your project's conventions.

To avoid sending noisy or potentially sensitive content to the model, commit message generation applies an extra filtering pass before diff analysis:

- Automatically omits large lockfile / snapshot diff bodies such as `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, and `*.snap`
- Automatically skips common sensitive files such as `.env*`, certificate/private key files, and files under `.aws` / `.ssh` / `.gnupg` / `.docker`
- Lets you add your own sensitive file matching rules through `gcmp.commit.sensitiveFiles`

<details>
<summary>Click to expand usage details</summary>

### System Requirements

- **vscode.git extension**: This feature depends on VS Code's built-in `vscode.git` extension to access Git repository information
    - The extension automatically detects Git availability; related buttons are hidden when Git is unavailable
    - If you've disabled the `vscode.git` extension, the commit message generation feature will be unavailable

### Entry Points: Git Source Control View

- Repository title bar button: `Generate Commit Message`
- Change group buttons:
    - On "Staged Changes": `Generate Commit Message - Staged Changes`
    - On "Changes": `Generate Commit Message - Unstaged Changes`

### Generation Scope (staged / working tree)

- `Generate Commit Message`: Default behavior, **analyzes staged + working tree** (tracked + untracked).
- `Generate Commit Message - Staged Changes`: Only analyzes **staged**, suitable for "incremental/split commits".
- `Generate Commit Message - Unstaged Changes`: Only analyzes **working tree** (tracked + untracked), excluding staged.

> Multi-repo workspaces: If the current workspace contains multiple Git repositories, GCMP will attempt to infer the repository from the SCM area you clicked; if inference fails, a repository selector will appear.

### Model Selection & Configuration

This feature calls models via the **VS Code Language Model API**.

- On first use or when no model is configured, you'll be guided to select a model (or manually run `GCMP: Select Commit Message Model`).
- Related settings:

```json
{
    "gcmp.commit.language": "chinese", // Generation language: chinese / english (fallback when auto mode language is unclear)
    "gcmp.commit.format": "auto", // Commit message format: auto (default) / see format details below
    "gcmp.commit.customInstructions": "", // Custom instructions (only effective when format=custom)
    "gcmp.commit.sensitiveFiles": [
        "*.pem",
        "**/.env.local",
        "secrets/**"
    ], // Extra sensitive file path patterns excluded from diff analysis
    "gcmp.commit.model": {
        "provider": "zhipu", // Model provider (providerKey, e.g., zhipu / minimax / compatible)
        "model": "glm-4.6" // Model ID (corresponding to VS Code Language Model's model.id)
    }
}
```

### `gcmp.commit.sensitiveFiles` Filter Rules

`gcmp.commit.sensitiveFiles` extends the built-in sensitive file filtering rules. It accepts a list of simple glob-like strings:

- `*.pem`: matches any `.pem` file
- `**/.env.local`: matches `.env.local` in any directory
- `secrets/**`: matches all files under the `secrets/` directory
- `**/private/*.key`: matches `.key` files under any `private` directory

When a file matches, it is excluded from commit diff analysis and is not sent to the model for commit message generation.

### `gcmp.commit.format` Format Reference & Examples

> Note: The examples below illustrate format patterns only; actual content is auto-generated based on your diff.

- `auto`: Auto-infer (references repository history language/style; falls back to `plain` + `gcmp.commit.language` when unclear). Default and recommended.

- `plain`: Concise one-liner, no type/scope/emoji (suitable for quick commits).

- `custom`: Fully controlled by your custom instructions (`gcmp.commit.customInstructions`).

- `conventional`: Conventional Commits (may include scope, typically "title + optional body points").

```text
feat(commit): add commit message generation

- Support staged / unstaged separate generation
- Auto-include relevant historical commits as reference
```

- `angular`: Angular style (`type(scope): summary`, semantically similar to conventional).

```text
feat(commit): add SCM entry points

- Add entry points to repository title bar and change group bar
```

- `karma`: Karma style (leans towards "single line", kept short).

```text
fix(commit): fix multi-repo selection
```

- `semantic`: Semantic `type: message` (no scope; may include body points).

```text
feat: add commit message generation

- Auto-identify key diffs from changes
```

- `emoji`: Emoji prefix (no type).

```text
✨ Add commit message generation
```

- `emojiKarma`: Emoji + Karma (emoji + `type(scope): msg`).

```text
✨ feat(commit): add commit message generation

- Better aligned with existing repository commit style
```

- `google`: Google style (`Type: Description`).

```text
Feat: Add commit message generation

- Support auto language and format selection based on repo style
```

- `atom`: Atom style (`:emoji: message`).

```text
:sparkles: Add commit message generation
```

</details>

## 🤝 Contributing

We welcome community contributions! Whether it's reporting bugs, suggesting features, or submitting code, you can help make this project better.

### Development Setup

```bash
# Clone the project
git clone https://github.com/VicBilibily/GCMP.git
cd GCMP
# Install dependencies
npm install
# Open in VS Code and press F5 to start extension debugging
```

## 💰 Sponsor

If you find this project helpful, consider supporting its continued development by [viewing the sponsor QR code](donate.jpg).

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
