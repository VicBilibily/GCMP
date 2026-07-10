# GCMP - Multi-Provider AI Chat Models for GitHub Copilot

English | **[中文](README.md)**

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![License](https://img.shields.io/badge/License-MIT-orange)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

Integrates leading Chinese AI model providers into GitHub Copilot Chat, giving developers richer, more locally-tuned AI coding assistant options.
Currently supports **ZhipuAI**, **MiniMax**, **MoonshotAI**, **DeepSeek**, **Alibaba Cloud DashScope**, **StreamLake**, **Volcengine**, **Tencent Cloud**, **Xiaomi MiMo**, **Baidu Qianfan**, **StepFun**, **Ant Ling**, **XunFei Astron**, and **LongCat** as native providers.
Additionally, the extension supports any OpenAI or Anthropic API-compatible models via the **Compatible Provider**.

## 🚀 Quick Start

### 1. Install the Extension

Search for `GCMP` in the VS Code Extension Marketplace, or use the identifier: [`vicanent.gcmp`](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)

### 2. Get Started

1. Open the `GitHub Copilot Chat` panel in VS Code
2. Click `Manage Models` at the bottom of the model selector, then choose a provider from the list
3. On first use, you'll be prompted to set an API Key. Complete the configuration and return to the model selector to enable the model
4. Select your target model in the model selector and start chatting with the AI assistant

### 3. Configure VS Code Utility and GCMP Auxiliary Models (Recommended)

> **VS Code 1.128+**: A startup dialog will automatically detect if `chat.utilityModel` and `chat.utilitySmallModel` are configured. If both are unset, a prompt will guide you through the setup. When using non-official Copilot models (BYOK/custom providers), unconfigured utility models will cause "No utility model is configured" errors.

VS Code uses lightweight background models for **utility tasks** like title generation, commit messages, search, and intent detection. GCMP features such as commit message generation and vision analysis also require their own model selections. If not configured manually, VS Code falls back to Copilot's built-in models, which consume your monthly quota — especially limited for free-tier users. Pointing these tasks to GCMP-provided models saves Copilot quota for more important work.

> 💡 **Quick configuration entry**: hover the Token-usage icon in the status bar and click the `Set auxiliary tool models` link at the bottom of the daily-statistics popup to open a visual panel for unified configuration of all the models below. You can also run `GCMP: Set Auxiliary Tool Models` from the command palette.

```json
{
    // General utility tasks: title generation, summaries, intent classification, rename suggestions, terminal commands/fixes, search, VS Code Q&A
    "chat.utilityModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-pro",
    // Lightweight utility tasks: commit messages, branch names, progress messages, todo tracking
    "chat.utilitySmallModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-flash",
    // Inline Chat default model
    "inlineChat.defaultModel": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    // Agent-mode sub-agents for exploration/planning (e.g., codebase search, plan generation)
    "chat.exploreAgent.defaultModel": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    "chat.planAgent.defaultModel": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    // GitHub Copilot Chat dedicated agents (Ask / Implement / Explore)
    "github.copilot.chat.askAgent.model": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    "github.copilot.chat.implementAgent.model": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    "github.copilot.chat.exploreAgent.model": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    // GCMP built-in commit message generation model
    "gcmp.commit.model": {
        "provider": "zhipu",
        "model": "glm-4.6"
    },
    // GCMP built-in vision analysis model (must support image input)
    "gcmp.vision.model": {
        "provider": "zhipu",
        "model": "glm-4.6v"
    }
}
```

> **Recommendation**: Use a fast-responding model for `utilitySmallModel` (for example, `deepseek-v4-flash`). You can pair it with `maxInputTokens: 16384` or a similarly low limit for quick tasks.
>
> When editing `settings.json`, place the cursor on the value and use VS Code IntelliSense to choose from registered models. **If left unset**, VS Code will use Copilot's built-in models for utility tasks, which may consume Copilot monthly quota for free-tier users. Using a GCMP model here helps avoid that.
>
> You can also run `GCMP: Set Auxiliary Tool Models` from the command palette to open a visual panel for unified configuration of all the models above.
>
> Shortcut entry: hover the Token-usage icon in the status bar and click the `Set auxiliary tool models` link at the bottom of the daily-statistics popup to open the same panel.

<details>
<summary>Click to expand detailed parameter descriptions</summary>

- `chat.utilitySmallModel`: Lightweight utility tasks (default: `gpt-4o-mini`). Covers `chat-title`, `git-commit-message`, `git-branch-name`, `inline-progress-message`, `prompt-categorizer`, `todo-tracker`, `rename-suggestions`, `terminal-command/quickfix/explain`, and `workspace-search`.
- `chat.utilityModel`: General utility tasks (default: CAPI fallback). Covers `settings-resolver`, `explain-code`, and `vscode-qa`.
- `inlineChat.defaultModel`: Inline Chat default model, used for in-editor inline chat (`Ctrl+I` / right-click "Chat Inline").
- `chat.exploreAgent.defaultModel`: Explore sub-agent default model, used for `search-subagent` codebase exploration and search.
- `chat.planAgent.defaultModel`: Plan sub-agent default model, used for planning and task decomposition in Agent mode.
- `github.copilot.chat.askAgent.model`: Ask Agent default model, used for Ask-mode Q&A.
- `github.copilot.chat.implementAgent.model`: Implement Agent default model, used for Implement-mode code generation.
- `github.copilot.chat.exploreAgent.model`: Explore Agent default model, used for Explore-mode codebase exploration.
- `gcmp.commit.model`: GCMP built-in commit message generation model.
- `gcmp.vision.model`: GCMP built-in vision analysis model; choose a model that supports image input.

</details>

## 🤖 Built-in AI Model Providers

> This extension only includes first-tier providers with self-developed models (e.g., major cloud vendors with model R&D capabilities). For third-party model access, use the "OpenAI / Anthropic Compatible" mode.

### [**ZhipuAI**](https://bigmodel.cn/)

- [**Coding Plan**](https://bigmodel.cn/glm-coding): **GLM-5.2**, **GLM-5V-Turbo**, **GLM-5-Turbo**, **GLM-4.7**, **GLM-4.6**, **GLM-4.6V**
    - **Usage tracking**: Status bar displays remaining cycle quota for GLM Coding Plan.
- **PayGo**: **GLM-5.2**, **GLM-5.1** (HighSpeed), **GLM-5V-Turbo**, **GLM-5-Turbo**, **GLM-5**, **GLM-4.7**, **GLM-4.7-FlashX**, **GLM-4.6**, **GLM-4.6V**
- **Free models**: **GLM-4.6V-Flash**
- [**International site**](https://z.ai/model-api): Supports switching to the international site (z.ai).
- **Search**: Integrated `Web Search MCP` and `Web Search API`, supports `#zhipuWebSearch` for web searches.
    - `Web Search MCP` mode is enabled by default. Coding Plan includes: Lite (100/month), Pro (1,000/month), Max (4,000/month).
    - Disable MCP mode in settings to use the `Web Search API` pay-per-request billing.

### [**MiniMax**](https://platform.minimaxi.com/login)

- [**Token Plan**](https://platform.minimaxi.com/subscribe/token-plan): **MiniMax-M3**, **MiniMax-M2.7** (HighSpeed), **MiniMax-M2.5** (HighSpeed), **MiniMax-M2.1**, **MiniMax-M2**
    - **Search**: Integrated Token Plan web search tool, supports `#minimaxWebSearch`.
    - **Usage tracking**: Status bar displays remaining Token Plan quota.
    - [**International site**](https://platform.minimax.io/subscribe/token-plan): Supports international site Token Plan.
- **PayGo**: **MiniMax-M3**, **MiniMax-M2.7** (HighSpeed), **MiniMax-M2.5** (HighSpeed), **MiniMax-M2.1** (HighSpeed), **MiniMax-M2**

### [**MoonshotAI**](https://platform.kimi.com/)

- [**Membership**](https://www.kimi.com/coding): Kimi membership plan includes `Kimi For Coding` (HighSpeed).
    - **Search**: Integrated Kimi Search web search tool, supports `#kimiWebSearch`.
    - **Usage tracking**: Status bar displays remaining quota and rate-limit reset time.
- Preset models: **Kimi K2.5**, **Kimi K2.6**, **Kimi K2.7 Code** (HighSpeed)
    - **Balance query**: Status bar displays current account balance.

### [**DeepSeek**](https://platform.deepseek.com/)

- Preset models: **DeepSeek-V4-Flash** (fast mode), **DeepSeek-V4-Pro** (expert mode)
    - **Balance query**: Status bar displays current account balance.

### [**Alibaba Cloud DashScope**](https://bailian.console.aliyun.com/) - AliDashScope

- [**Coding Plan**](https://www.aliyun.com/benefit/scene/codingplan)
    - Recommended: **Qwen3.6-Plus**, **Kimi-K2.5**, **GLM-5**, **MiniMax-M2.5**
    - More: **Qwen3.5-Plus**, **Qwen3-Max**, **Qwen3-Coder-Next**, **Qwen3-Coder-Plus**, **GLM-4.7**
- [**Token Plan**](https://www.aliyun.com/benefit/scene/tokenplan): **Qwen3.7-Max**, **Qwen3.6-Plus**, **Qwen3.6-Flash**, **GLM-5.2**, **GLM-5.1**, **GLM-5**, **Kimi-K2.7-Code**, **Kimi-K2.6**, **Kimi-K2.5**, **MiniMax-M2.5**, **DeepSeek-V4-Pro**, **DeepSeek-V4-Flash**, **DeepSeek-V3.2**
- **Qwen series**: **Qwen3.7-Plus**, **Qwen3.7-Max**, **Qwen3.6-Max**, **Qwen3.6-Plus**, **Qwen3.6-Flash**, **Qwen3.5-Plus**, **Qwen3.5-Flash**
- **DeepSeek-V4**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**
- **Other PayGo models**: **GLM-5.2**, **Kimi-K2.7-Code**
- **Search**: Integrated [Web Search MCP](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3023217) tool (2,000/month), supports `#bailianWebSearch`. (Uses [DashScope API Key](https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key), not the Coding Plan API Key)

### [**StreamLake**](https://streamlake.com/product/kat-coder) - Kwai WanQing

- [**KwaiKAT Coding Plan**](https://streamlake.com/marketing/coding-plan): **KAT-Coder-Pro-V2**
- **KAT-Coder series**: **KAT-Coder-Pro-V2** (PayGo)

### [**Volcengine**](https://www.volcengine.com/product/ark)

- [**Coding Plan**](https://www.volcengine.com/activity/codingplan):
    - Doubao models: **Ark-Code-Latest**(Auto), **Doubao-Seed-2.0-Code**, **Doubao-Seed-Code**, **Doubao-Seed-2.0-lite**, **Doubao-Seed-2.0-pro**
    - Open-source models: **GLM-5.2**, **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **Kimi-K2.7-Code**, **Kimi-K2.6**, **MiniMax-M3**, **MiniMax-M2.7**
- [**Agent Plan**](https://www.volcengine.com/activity/agentplan):
    - Doubao models: **Ark-Code-Latest**(Auto), **Doubao-Seed-2.0** (Code/pro/lite/mini)
    - Open-source models: **GLM-5.2**, **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **MiniMax-M3**, **MiniMax-M2.7**, **Kimi-K2.7-Code**, **Kimi-K2.6**
- **Doubao series**: **Doubao-Seed-Evolving**, **Doubao-Seed-2.1** (turbo/pro), **Doubao-Seed-2.0** (lite/mini/pro/Code), **Doubao-Seed-1.8**
- **Collaboration rewards**: **GLM-4.7**, **DeepSeek-V3.2**
- **PayGo**: **DeepSeek-V4-Flash-260425**, **DeepSeek-V4-Pro-260425**
- **Key configuration**: Supports separate [Coding Plan API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) and [Agent Plan API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan). Setup wizard guides you through plan type selection.

### [**Tencent Cloud**](https://cloud.tencent.com/product/hunyuan)

- [**Coding Plan**](https://console.cloud.tencent.com/tokenhub/codingplan)
    - Open-source models: **GLM-5**, **Kimi-K2.5**, **MiniMax-M2.5**
- [**Token Plan**](https://console.cloud.tencent.com/tokenhub/tokenplan): **HY 3 Preview**, **GLM-5.1**, **GLM-5**, **Kimi-K2.5**, **MiniMax-M2.7**, **MiniMax-M2.5**, **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**
- [**TokenHub**](https://console.cloud.tencent.com/tokenhub/models):
    - **GLM series**: **GLM-5.2**, **GLM-5.1**, **GLM-5V-Turbo**, **GLM-5-Turbo**, **GLM-5**
    - **DeepSeek series**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **DeepSeek-V3.2**
    - **Kimi series**: **Kimi-K2.7-Code**, **Kimi-K2.6**, **Kimi-K2.5**
    - **MiniMax series**: **MiniMax-M3**, **MiniMax-M2.7**, **MiniMax-M2.5**
    - **Hunyuan series**: **HY 3 Preview**, **Tencent HY 2.0 Instruct**, **Tencent HY 2.0 Think**
- **Key configuration**: Tencent Cloud API keys are categorized into [paid model API Key](https://hunyuan.cloud.tencent.com/#/app/apiKeyManage), [Coding Plan API Key](https://console.cloud.tencent.com/tokenhub/codingplan), [Token Plan API Key](https://console.cloud.tencent.com/tokenhub/tokenplan), [DeepSeek API Key](https://console.cloud.tencent.com/lkeap/api), and [TokenHub API Key](https://console.cloud.tencent.com/tokenhub/apikey). Each must be generated from the correct key management page.

### [**Xiaomi MiMo**](https://platform.xiaomimimo.com/#/console/api-keys)

- **PayGo**: **MiMo-V2.5-Pro** (UltraSpeed), **MiMo-V2.5**
- [**Token Plan**](https://platform.xiaomimimo.com/#/token-plan): **MiMo-V2.5-Pro**, **MiMo-V2.5**
    - [Regional clusters](https://platform.xiaomimimo.com/#/docs/tokenplan/subscription?target=快速指南): Switch between `China (cn)`, `Singapore (sgp)`, and `Europe (ams)` clusters. Refer to the [subscription management](https://platform.xiaomimimo.com/#/console/plan-manage) page for details.
- **Key configuration**: Supports separate [Xiaomi MiMo API Key](https://platform.xiaomimimo.com/#/console/api-keys) and [Token Plan API Key](https://platform.xiaomimimo.com/#/console/plan-manage).

### [**Baidu Qianfan**](https://cloud.baidu.com/product-s/qianfan_home)

- **PayGo**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **DeepSeek-V3.2**, **GLM-5.2**, **GLM-5.1**, **GLM-5**, **Kimi-K2.6**, **Kimi-K2.5**, **ERNIE-5.1**, **ERNIE-5.0**
- [**Coding Plan**](https://cloud.baidu.com/product/codingplan): **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **GLM-5.1**, **DeepSeek-V3.2**, **GLM-5**, **Kimi-K2.5**
- **Key configuration**: Supports separate [Baidu Qianfan API Key](https://console.bce.baidu.com/qianfan/ais/console/apiKey) and [Coding Plan API Key](https://console.bce.baidu.com/qianfan/resource/subscribe).

### [**StepFun**](https://platform.stepfun.com/)

- [**Step Plan**](https://platform.stepfun.com/step-plan): **Step-3.7-Flash**, **Step-3.5-Flash**, **Step-3.5-Flash-2603**, **Step-Router-V1**
- **PayGo**: **Step-3.7-Flash**, **Step-3.5-Flash**, **Step-3.5-Flash-2603**
- **Search**: Integrated `#stepfunWebSearch` MCP web search tool with category filtering.
    - Step Plan subscriptions use MCP; non-subscription users use standard pay-per-request billing.

### [**Ant Ling**](https://www.ant-ling.com/)

Ant Group's open-source MoE-architecture LLM family, accessed via Anthropic mode.

- **PayGo**: **Ling-2.6-1T** (flagship), **Ling-2.6-flash** (cost-effective), **Ring-2.6-1T** (deep reasoning)
- [**Free quota**](https://developer.ant-ling.com/zh-CN/docs/models/price/): 500,000 free tokens per day (input + output shared).

### [**XunFei Astron**](https://maas.xfyun.cn/)

LLM service platform under iFLYTEK, accessed via Anthropic SDK mode with dual-plan key management.

- [**Coding Plan**](https://maas.xfyun.cn/packageSubscription): **Spark X2**, **Spark-X2-Flash**, **DeepSeek-V4-Pro**, **DeepSeek-V4-Flash**, **DeepSeek-V3.2**, **GLM-5.2**, **GLM-5.1**, **GLM-5**, **GLM-4.7-Flash**, **Kimi-K2.6**, **Kimi-K2.5**, **MiniMax-M2.5**, **Qwen3.6-35B-A3B**, **Qwen3.5-35B-A3B**, **Qwen3.5-397B-A17B**, **Qwen3-Coder-Next-FP8**
- [**Token Plan**](https://maas.xfyun.cn/tokenPlan): Same 16 models served via a dedicated Token Plan endpoint.
- **Key configuration**: Supports separate [Coding Plan API Key](https://maas.xfyun.cn/packageSubscription) and [Token Plan API Key](https://maas.xfyun.cn/tokenPlan). Setup wizard guides you through plan type selection.

### [**LongCat**](https://longcat.chat/platform/) - LongCat

- **Built-in model**: **LongCat-2.0** Agentic model from the LongCat API platform, accessed via Anthropic SDK mode.

### CLI Coding Tool API Providers

> The following providers are themselves AI coding CLI tools (similar to Claude Code) that expose API endpoints for third-party access to their aggregated model capabilities.

### [**OpenCode**](https://opencode.ai/)

- [**Go**](https://opencode.ai/go?ref=2TEVV934MY): **GLM-5.2**, **GLM-5.1**, **Kimi-K2.7-Code**, **Kimi-K2.6**, **Kimi-K2.5**, **MiMo-V2.5**, **MiMo-V2.5-Pro**, **MiniMax-M3**, **MiniMax-M2.7**, **Qwen3.7-Max**, **Qwen3.7-Plus**, **Qwen3.6-Plus**, **DeepSeek-V4-Pro**, **DeepSeek-V4-Flash**
- **Zen**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **GLM-5**, **GLM-5.1**, **GLM-5.2**, **Kimi-K2.5**, **Kimi-K2.6**, **Qwen3.5-Plus**, **Qwen3.6-Plus**, **Grok-Build-0.1**, **MiniMax-M2.5**, **MiniMax-M2.7**

### [**Hyper**](https://hyper.charm.land/) - Charm Hyper

- **Preset models**: **DeepSeek-V4-Flash**, **DeepSeek-V4-Pro**, **Qwen3.7-Max**, **Qwen3.7-Plus**, **Qwen3.6-Plus**, **Qwen3.6-Max**, **Qwen3.6-Flash**, **Qwen3-Coder-480B-A35B-Instruct-INT4-Mixed-AR**, **Qwen3-Next-80B-A3B-Instruct**, **GLM-5.2**, **GLM-5.1**, **GLM-5**, **Kimi-K2.7-Code**, **Kimi-K2.6**, **Kimi-K2.5**, **MiniMax-M2.7**, **Llama-4-Maverick-17B-128E-Instruct-FP8**, **Llama-3.3-70B-Instruct**, **Gemma-4-26B-A4B**, **GPT-OSS-120B**

### [**ClinePass**](https://docs.cline.bot/getting-started/clinepass) - Cline's official model subscription service

- **Preset models**: **GLM-5.2**, **Kimi-K2.7-Code**, **Kimi-K2.6**, **DeepSeek-V4-Pro**, **DeepSeek-V4-Flash**, **MiMo-V2.5**, **MiMo-V2.5-Pro**, **MiniMax-M3**, **Qwen3.7-Max**, **Qwen3.7-Plus**
- **API Key**: Create and copy your API key from [Cline App → API Keys](https://app.cline.bot/dashboard/account?tab=api-keys), then use the `GCMP: Set ClinePass API Key` command to configure it.

### OAuth Coding Assistant Providers

> ⚠️ **Risk Warning**: The following providers access APIs by simulating OAuth authentication of official CLI tools. **This may violate third-party terms of service and carries the risk of account bans.** Use only if you are fully informed and voluntarily accept the risks.

### [**Codex CLI**](https://chatgpt.com/codex) - OpenAI Codex

OpenAI's official coding assistant Codex CLI tool. Supports authentication via the `codex` CLI (requires local installation).

```bash
npm install -g @openai/codex@latest
```

- **Supported models**: **GPT-5.6** (Sol/Terra/Luna), **GPT-5.5**, **GPT-5.4-mini**, **GPT-5.4**
- **Usage tracking**: Status bar displays remaining ChatGPT subscription cycle quota.- **Independent proxy settings**: Codex CLI uses its own proxy configuration (independent of the extension-wide `gcmp.proxy`). You can specify a dedicated proxy for Codex requests via `gcmp.providerOverrides.codex.proxy`.

```json
{
    "gcmp.providerOverrides": {
        "codex": {
            "proxy": "http://127.0.0.1:10808"
        }
    }
}
```

### [**Grok Build**](https://x.ai/cli) - xAI Grok Build

xAI's official Grok Build coding assistant CLI tool. Supports OAuth authentication via the `grok` CLI (requires local installation).

```bash
# macOS / Linux
curl -fsSL https://x.ai/cli/install.sh | bash

# Windows PowerShell
irm https://x.ai/cli/install.ps1 | iex
```

- **Supported models**: **Grok 4.5**, **Grok Build 0.1**, **Grok Composer 2.5 (fast)**

## ⚙️ Advanced Configuration

GCMP supports customizing AI model behavior parameters through VS Code settings for a more personalized experience.

> 📝 **Note**: All `settings.json` parameter changes take effect immediately.

<details>
<summary>Click to expand advanced configuration details</summary>

### General Model Parameters & Extra Features

```json
{
    "gcmp.retry.enabled": true, // Enable auto retry (default true), disable to stop on failure
    "gcmp.retry.maxAttempts": 3 // 1-5, only effective for retryable errors
}
```

- `gcmp.retry.enabled` defaults to `true`. When enabled, automatically retries retryable errors like 429. Set to `false` to disable retries entirely and stop immediately on failure.
- `gcmp.retry.maxAttempts` defaults to `3`, controlling the maximum automatic retry count for 429, rate-limit, and temporary overload errors.
- Current retry delay sequence: `1s → 3s → 6s → 10s → 15s`. Once the limit is reached, the last error is thrown directly.
- `gcmp.maxTokens` is **deprecated**: this setting no longer takes effect; each model now automatically uses its own `maxOutputTokens` configuration.

> Feature-specific settings such as `gcmp.commit.enabled`, `gcmp.vision.model`, and `gcmp.zhipu.search.enableMCP` are documented in their respective feature sections, not here.

#### Proxy & System Certificate Settings

```json
{
    "gcmp.proxy": "http://127.0.0.1:7890", // Optional global proxy, full URL recommended
    "gcmp.tls.useSystemCertificates": true // Append OS root CAs (enabled by default)
}
```

- `gcmp.proxy` acts as the default proxy for all extension network requests, including chat requests, FIM / NES completions, web search tools, MCP clients, status-bar quota/balance queries, Compatible Provider model discovery requests, and CLI OAuth refresh calls.
- Proxy precedence is: `model.proxy` → `gcmp.providerOverrides.<provider>.proxy` → `gcmp.providerOverrides.compatible.proxy` (non-built-in only) → `gcmp.proxy` → VS Code `http.proxy` → environment variables (`HTTPS_PROXY` / `HTTP_PROXY`) → **System proxy (auto-detected)**.
- Supports `host:port` shorthand (e.g., `127.0.0.1:7890`), but using a full URL like `http://127.0.0.1:7890` is recommended.
- Set to `noproxy` to bypass all proxies (including system proxies and configured ones). When any layer in the proxy chain is set to `noproxy`, fallback short-circuits immediately.
- When no explicit proxy is configured, the extension automatically detects system proxy settings from the Windows Registry or macOS `scutil`.
- > ⚠️ PAC (Proxy Auto-Config) is not supported. If your system proxy uses PAC, it will be ignored — use an explicit proxy URL instead.
- `gcmp.tls.useSystemCertificates` appends operating-system trusted root certificates to Node.js' default CA list, which is useful behind enterprise proxies, internal gateways, or locally installed private root CAs.
- Authenticated proxy URLs are supported; usernames and passwords are automatically redacted in logs.

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

GCMP supports overriding provider defaults through the `gcmp.providerOverrides` setting. Support varies by provider type:

| Provider Type                        | Supported Fields                               | models[]                               |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------- |
| **Built-in** (deepseek/zhipu etc.)   | `baseUrl`, `customHeader`, `proxy`, `models[]` | ✅ Full model add/override             |
| **Known** (aihubmix/openrouter etc.) | `customHeader`, `proxy`                        | ❌ Use `gcmp.compatibleModels` instead |
| **Custom** (from compatibleModels)   | `customHeader`, `proxy`                        | ❌ Use `gcmp.compatibleModels` instead |
| **compatible** itself                | `customHeader`, `proxy`                        | ❌ Use `gcmp.compatibleModels` instead |

**Override precedence**:

```
model-level > providerOverrides.{provider} > providerOverrides.compatible
```

- `providerOverrides.compatible` acts as global defaults for all Compatible Provider models
- Proxy: `model.proxy` > `providerOverrides.{provider}.proxy` > `providerOverrides.compatible.proxy` (non-built-in only) > `gcmp.proxy` > VS Code `http.proxy` > environment variables
- Custom headers: `providerOverrides.{provider}.customHeader` > model `customHeader` > `providerOverrides.compatible.customHeader`

**Configuration example**:

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "proxy": "http://127.0.0.1:7890", // Optional provider-level default proxy
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
        },
        "aihubmix": {
            "proxy": "http://127.0.0.1:7890", // proxy override also supported
            "customHeader": { "X-Custom": "value" }
        },
        "compatible": {
            "proxy": "http://127.0.0.1:7890" // global default proxy for all Compatible Provider models
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
> If you need built-in or special adaptation support, please submit an Issue with relevant information.<br/>
> Known providers support `gcmp.providerOverrides.{providerId}` for `customHeader` and `proxy` overrides.

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
            // "proxy": "http://127.0.0.1:7890", // Optional: applies only to this model and to the "Fetch Models" probe request
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

- `gcmp.compatibleModels[*].proxy` applies only to the current custom model. When you click "Fetch Models" after entering `baseUrl`, the same proxy setting is also used for the discovery request.

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

### Custom provider balance/usage query example: intelligent merge of `usage` + `usages`

For a `Compatible` custom provider, you can configure the following under `gcmp.providerOverrides.{providerId}`:

- `usage`: optional; for a single balance query, configuring only this is enough, and it can also serve as the shared defaults for `usages`
- `usages`: optional; use this only when you need multiple named balance/amount query modes, and each item can incrementally override fields from `usage`

In other words:

- configure only `usage`: a single balance query
- use `usages` only when you need multiple query modes for different balances/amounts
- configure neither `usage` nor `usages`: no balance/usage query will be registered for this custom provider

For built-in known provider `usage` / `usages` reference configurations, see the source file [src/utils/knownProviders.ts](src/utils/knownProviders.ts).

> Note: the provider key in `gcmp.providerOverrides` must match `gcmp.compatibleModels[*].provider` **exactly**, including letter case.

For example, the following [NekoCode](https://nekocode.ai?aff=U9XPRBID)-related snippet is closer to a real-world `settings.json` setup:

- multiple models in `gcmp.compatibleModels` share the same `provider: "NekoCode"`
- `gcmp.providerOverrides.NekoCode.usage` defines the default query URL `https://api2.nekoapi.ai/v1/usage` and the shared field path `balance`
- `gcmp.providerOverrides.NekoCode.usages.pay` resolves to the same final query config as `usage`, and only adds the display name `Balance`
- `gcmp.providerOverrides.NekoCode.usages.sub` reuses `usage.fields.balance` but overrides the query URL to `https://api2.nekoapi.ai/v1/user/balance`

```json
{
    "gcmp.compatibleModels": [
        {
            "id": "nekocode:gpt-5.5",
            "name": "GPT-5.5 (NekoCode)",
            "provider": "NekoCode",
            "model": "gpt-5.5",
            "sdkMode": "openai-responses",
            "baseUrl": "https://api2.nekoapi.ai/v1",
            "proxy": "noproxy",
            "maxInputTokens": 272000,
            "maxOutputTokens": 128000,
            "capabilities": {
                "toolCalling": true,
                "imageInput": true
            },
            "reasoningDefault": "xhigh",
            "reasoningEffort": ["none", "low", "medium", "high", "xhigh"],
            "extraBody": {
                "store": false,
                "reasoning": {
                    "effort": "xhigh",
                    "summary": "auto"
                }
            },
            "useInstructions": true,
            "customHeader": {
                "version": "0.134.0",
                "user-agent": "codex-tui/0.134.0 (Windows 10.0.26200; x86_64) unknown (codex-tui; 0.134.0)",
                "originator": "codex-tui"
            }
        }
    ],
    "gcmp.providerOverrides": {
        "NekoCode": {
            "usage": {
                "url": "https://api2.nekoapi.ai/v1/usage",
                "fields": {
                    "balance": "balance"
                }
            },
            "usages": {
                "pay": {
                    "displayName": "Balance",
                    "url": "https://api2.nekoapi.ai/v1/usage"
                },
                "sub": {
                    "displayName": "Subscription",
                    "url": "https://api2.nekoapi.ai/v1/user/balance",
                    "fields": {
                        "balance": "remaining"
                    }
                }
            }
        }
    }
}
```

The effective behavior of this configuration is:

- `providerOverrides.NekoCode` applies to all compatible models whose `provider` is `"NekoCode"`, such as `GPT-5.4 (NekoCode)` and `GPT-5.5 (NekoCode)` above
- `pay` inherits `usage.fields.balance = "balance"`
- `sub` also inherits `usage.fields.balance = "balance"`
- because `pay` resolves to the same final query config as `usage`, no extra duplicate `default` mode will be emitted

The status bar will therefore query and display two named modes:

- `NekoCode / Balance`
- `NekoCode / Subscription`

</details>

## 💡 FIM / NES Inline Completion Suggestions

- **FIM**: Predicts and completes missing code at the cursor position based on context, suitable for single-line/short snippet completion.
- **NES**: Provides intelligent code suggestions based on editing context, supporting multi-line code generation.

> **Important**: An API Key must be configured and verified in a chat model first. Select `GitHub Copilot Inline Completion via GCMP` in the Output panel to view debug info. These use general-purpose LLMs **not specifically trained for code completion**, so results may not match Copilot's native Tab completion.

<details>
<summary>Click to expand detailed configuration</summary>

### FIM / NES Inline Completion Model Configuration

FIM and NES completions use separate model configurations, configurable via `gcmp.fimCompletion.modelConfig` and `gcmp.nesCompletion.modelConfig`.

> **Proxy Configuration**: FIM and NES support a `proxy` field to set a dedicated proxy address (e.g., `http://127.0.0.1:7890`) for debugging under different network conditions. Authenticated proxies are supported; user credentials are automatically redacted in logs.

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
        // "proxy": "http://127.0.0.1:7890", // Optional: set a dedicated proxy
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
        // "proxy": "http://127.0.0.1:7890", // Optional: set a dedicated proxy
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
        // "proxy": "http://127.0.0.1:7890", // Optional: set a dedicated proxy
        "model": "codestral-latest",
        "extraBody": { "code_annotations": null },
        "maxTokens": 100
    }
}
```

### Circuit Breaker

When FIM or NES completion requests fail consecutively, the circuit breaker temporarily pauses requests to prevent endless retries, saving both resources and costs.

**Three-state model**:

| State        | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| **Closed**   | Normal operation — requests pass through, failures are counted                              |
| **Open**     | Tripped — all requests are rejected, cooldown countdown begins                              |
| **HalfOpen** | Cooldown elapsed — allows one probe request; success restores Closed, failure re-trips Open |

**Workflow**:

1. Consecutive failures reach `failureThreshold` → breaker transitions Closed → Open
2. In Open state, all requests are immediately rejected; wait `cooldownSeconds` seconds
3. After cooldown, the first `allowRequest()` enters HalfOpen and issues one probe request
4. Probe succeeds (`recordSuccess()`) → back to Closed, service restored
5. Probe fails (`recordFailure()`) → back to Open, cooldown restarts. **One retry per cooldown cycle** (once every 30 seconds by default) until success or manual "Retry Now"
6. Request cancelled by user (`recordCancellation()`) → probe slot is returned, re-probing allowed

**Notification**: A warning popup appears on the first Open transition (throttled to once per 30 seconds), offering "Retry Now" to reset the breaker or "View Settings" to navigate to the configuration page.

**Configuration**:

```json
{
    // FIM circuit breaker settings (enabled by default)
    "gcmp.fimCompletion.circuitBreaker": {
        "enabled": true, // Enable circuit breaker
        "failureThreshold": 10, // Default 10, range 2-60
        "cooldownSeconds": 30 // Default 30, range 10-300
    },
    // NES circuit breaker settings (enabled by default)
    "gcmp.nesCompletion.circuitBreaker": {
        "enabled": true, // Enable circuit breaker
        "failureThreshold": 5, // Default 5, range 2-20
        "cooldownSeconds": 30 // Default 30, range 10-300
    }
}
```

> Configuration changes take effect immediately, no VS Code restart needed.

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
- **Request kind classification**: Records and displays the Copilot request kind for each request (e.g., main agent, title generation, commit message, search subagent, vision recognition) so you can track the actual consumption of background utility tasks
- **Real-time Request Metrics**: Displays time-to-first-token (TTFT) and time-per-output-token (TPOT) in real time during streaming, naturally refreshed by actual usage once completed
- **Real-time Output Token Estimation**: Streaming-phase output tokens and output speed (tokens/s) are estimated in real time via tokenizer; the output column shows the "last received estimation delta" (`+xx tks`), replaced by actual usage once completed
- **Cache hit rate visualization**: The input column combines cache hit count and total input, showing the cache hit rate to help judge cache strategy effectiveness

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
    "gcmp.commit.enabled": true, // Enable built-in commit message generation (default true, will be removed in next major version)
    "gcmp.commit.language": "chinese", // Generation language: chinese / english (fallback when auto mode language is unclear)
    "gcmp.commit.format": "auto", // Commit message format: auto (default) / see format details below
    "gcmp.commit.customInstructions": "", // Custom instructions (only effective when format=custom)
    "gcmp.commit.sensitiveFiles": ["*.pem", "**/.env.local", "secrets/**"], // Extra sensitive file path patterns excluded from diff analysis
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

## 👁️ Vision Analysis Tools

GCMP includes a set of dedicated vision analysis tools for converting images/screenshots into actionable development artifacts, extracting text, diagnosing errors, understanding technical diagrams, analyzing data visualizations, and comparing UI differences. All vision analysis is delegated to native multimodal GCMP models without relying on third-party MCP backends.

<details>
<summary>Click to expand vision analysis tool details</summary>

### Tool List

| Tool Reference                    | Purpose                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `#gcmpUiToArtifact`               | Convert UI screenshots into front-end code, AI prompts, design specs, or natural language descriptions   |
| `#gcmpExtractTextFromScreenshot`  | Extract and recognize text (OCR) from screenshots, supporting code, terminal output, documents, etc.     |
| `#gcmpDiagnoseErrorScreenshot`    | Analyze error dialogs, stack traces, and exception screenshots to identify root causes and suggest fixes |
| `#gcmpUnderstandTechnicalDiagram` | Analyze architecture diagrams, flowcharts, UML, ER diagrams, and system design diagrams                  |
| `#gcmpAnalyzeDataVisualization`   | Extract trends, anomalies, and actionable insights from charts, graphs, and dashboards                   |
| `#gcmpUiDiffCheck`                | Compare expected/reference UI screenshots against actual implementations to identify visual differences  |
| `#gcmpAnalyzeImage`               | General image analysis for visual content not covered by specialized tools                               |

### How to Use

Vision tools are invoked via `#` references, e.g. `#gcmpUiToArtifact`. When calling a tool, you can paste images, screenshots, or reference image file paths, and the model will generate the corresponding artifact or analysis based on the image content. All tools share the same vision analysis model configuration.

### Configuring the Vision Analysis Model

Vision tools rely on a multimodal model specified by `gcmp.vision.model`. If unset, a selection wizard is launched on first use; you can also manually run `GCMP: Select Vision Analysis Model` or configure it through the `GCMP: Set Auxiliary Tool Models` panel.

```json
{
    "gcmp.vision.model": {
        "provider": "zhipu",
        "model": "glm-4.6v"
    }
}
```

- The selected model must support image input (`capabilities.imageInput: true`).
- Built-in provider models, Compatible Provider models with image input support, and GitHub Copilot native multimodal models are all supported (set `provider` to `copilot` and `model` to the Copilot model ID).
- If unset, the model selection wizard is launched automatically on first use, so you don't need to fill in JSON manually in advance.

</details>

## 🔑 API Key Sync Across Devices

GCMP provides an API Key synchronization feature based on **GitHub Secret Gists**, enabling you to sync API keys across devices using the same GitHub account without manual reconfiguration.

### How to Use

- Hover over the token usage indicator in the status bar, then click **"Manage / Sync API Keys"** at the bottom of the tooltip to enter quickly
- Or run the command `GCMP: Manage / Sync API Keys` from the command palette
- On first use, you'll be prompted to authenticate with GitHub and authorize the `gist` scope
- After authentication, a grouped sync actions menu appears:

    | Group               | Actions                                                                                                            |
    | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
    | **Sync Operations** | **Upload to Gist** — encrypt & upload to GitHub Gist / **Download from Gist** — restore from Gist to local         |
    | **Key Management**  | **Manage Local Keys** — view, enable, or remove local API keys / **Manage Remote Keys** — view/remove keys on Gist |
    | **Security**        | **Set/Change Passphrase** / **Clear Passphrase** — manage custom encryption passphrase                             |

> During upload/download, you can **select which providers to sync with inline status display** (new/update/unchanged). On upload, new and changed keys are checked by default. On download, keys that match local values are unchecked by default. Partial uploads merge with existing remote data without overwriting unselected keys.

<details>
<summary>View detailed encryption and security documentation</summary>

### Storage Architecture

| Layer              | Description                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **Remote Storage** | GitHub **Secret Gist** (private), file named `gcmp-sync.json`                                    |
| **Encryption**     | **AES-256-GCM** (authenticated encryption — confidentiality + integrity)                         |
| **Key Derivation** | **scrypt** (N=16384, r=8, p=1) with `GitHub User ID + fixed pepper + optional custom passphrase` |
| **Authentication** | VS Code built-in **GitHub OAuth** via `vscode.authentication` API                                |
| **Token Scope**    | First-time authorization requests `gist` scope; subsequent operations reuse the session silently |

### Encryption Flow

```
GitHub numeric ID + pepper + [custom passphrase] → scrypt(N=16384, r=8, p=1) → AES-256 key
                                                                                 ↓
Each API Key → Random Salt(32B) + Random IV(16B) → AES-256-GCM → Salt+IV+Tag+Ciphertext → JSON
```

- Each key is encrypted with an **independent random salt and initialization vector** — the same plaintext produces different ciphertext each time
- The encrypted payload includes `Salt`, `IV`, `Tag` (authentication tag), and `Ciphertext`, all hex-encoded
- **Decryption depends on the GitHub numeric user ID**: the same GitHub account derives the same encryption key across devices

### Custom Encryption Passphrase

> Since this extension is **open source**, the encryption method (pepper, scrypt parameters, etc.) is visible in the source code. If you want extra protection, you can set a custom encryption passphrase.

- Select "Set Encryption Passphrase" from the sync actions menu; you'll be asked to enter it twice for confirmation
- The passphrase is combined with the GitHub user ID and pepper for key derivation — all three are required (minimum 8 characters)
- **After changing the passphrase, data encrypted with the old passphrase cannot be decrypted** (different derived key)
- The passphrase is stored locally via VS Code `SecretStorage` (OS-level encryption) and is never uploaded to any server
- Different devices sharing the same GitHub account need to use the **same passphrase** to decrypt each other's data

#### Passphrase Verification on Download

If the local passphrase doesn't match the one used during upload, a prompt will appear:

- **Passphrase set but decryption fails** → prompts that the passphrase may have changed; guides you to enter the previous one
- **No passphrase set but data is undecryptable** → prompts that the data may have been encrypted with a passphrase on another device; guides you to enter it
- After entering the passphrase, it is verified automatically: if decryption succeeds, the correct passphrase is stored for future use
- If only some keys can be decrypted, a mismatch count is shown

#### Cross-Device Guidance

When setting the passphrase, a notice is displayed explaining that all devices must use the same passphrase:

- **First-time setup**: reminds you to remember the passphrase and set it on all devices
- **Changing passphrase**: reminds you to update it on all devices

#### Data Compatibility

- When setting/changing the passphrase with existing Gist data, you can choose **"Set & Re-upload"** to immediately re-upload your keys with the new passphrase
- Clearing the passphrase requires confirmation; existing encrypted data will become undecryptable afterwards

### Security Notes

- The Gist is visible in the user's Gist list, but its content is **AES-256-GCM encrypted** and unreadable without decryption
- The encryption key is never transmitted over the network
- Local API keys are stored via VS Code's built-in `SecretStorage` (OS-level encrypted storage)
- All network requests use HTTPS

</details>

---

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
