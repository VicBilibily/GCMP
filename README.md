# GCMP - 提供多个国内原生大模型提供商支持的扩展

**[English](README.en.md)** | 中文

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![License](https://img.shields.io/badge/License-MIT-orange)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内主流原生大模型提供商，为开发者提供更加丰富、更适合本土需求的 AI 编程助手选择。
目前已内置支持 智谱AI、MiniMax、MoonshotAI、DeepSeek、阿里云百炼、快手万擎、火山方舟、腾讯云、Xiaomi MiMo、百度千帆、阶跃星辰、蚂蚁百灵、讯飞星辰、LongCat 等**原生大模型**提供商。
此外，扩展插件已适配支持 OpenAI 与 Anthropic 的 API 接口兼容模型，支持自定义接入任何提供兼容接口的第三方**云服务模型**。

## 🚀 快速开始

### 1. 安装扩展

在VS Code扩展市场搜索 `GCMP` 并安装，或使用扩展标识符：[`vicanent.gcmp`](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)

### 2. 开始使用

1. 打开 `VS Code` 的 `GitHub Copilot Chat` 面板
2. 在模型选择器的底部选择 `管理模型`，从弹出的模型提供商列表中选择所需的提供商
3. 若第一次使用，选择提供商后会要求设置 ApiKey，根据提示完成API密钥配置后，即可返回模型选择器添加并启用模型
4. 在模型选择器中选中目标模型后，即可开始与AI助手进行对话

### 3. 配置 VS Code 后台实用模型与 GCMP 辅助模型（推荐）

> **VS Code 1.128+**：启动时将自动检测 `chat.utilityModel` 与 `chat.utilitySmallModel` 是否已配置。若两者均未配置，会弹窗引导设置。使用非官方 Copilot 模型（BYOK/自定义提供商）时，缺少配置的辅助模型会触发 "No utility model is configured" 报错。

VS Code 在后台使用轻量级模型执行标题生成、提交信息创建、搜索、意图检测等**实用任务**；GCMP 的提交消息生成、视觉分析等功能也需要独立指定模型。若未手动配置，VS Code 会回退到 Copilot 内置模型，这会消耗月度额度（尤其是免费用户的有限配额）；将这些任务指向 GCMP 提供的模型可节省 Copilot 额度给更重要的用途。

> 💡 **快速配置入口**：悬停状态栏的 Token 消耗图标，在弹出的每日统计底部文本菜单点击「设置辅助工具模型」，即可打开可视化面板统一配置下列全部模型；也可通过命令面板执行 `GCMP: 设置辅助工具模型`。

<details>
<summary>展开查看各参数详细说明</summary>

```json
{
    // 通用实用任务：标题生成、摘要、意图分类、重命名建议、终端命令/修复/解释、搜索助手、VS Code 问答
    "chat.utilityModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-pro",
    // 轻量实用任务：提交信息、分支名生成、进度消息、待办跟踪（建议用快速低成本模型）
    "chat.utilitySmallModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-flash",
    // 内联聊天（Inline Chat）默认模型
    "inlineChat.defaultModel": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    // Agent 模式中的探索/规划子 Agent（如代码库搜索、方案规划）
    "chat.exploreAgent.defaultModel": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    "chat.planAgent.defaultModel": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    // GitHub Copilot Chat 各专用 Agent（Ask / Implement / Explore）
    "github.copilot.chat.askAgent.model": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    "github.copilot.chat.implementAgent.model": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    "github.copilot.chat.exploreAgent.model": "GLM-4.7 (CodingPlan) (gcmp.zhipu)",
    // GCMP 内置 Commit 消息生成模型
    "gcmp.commit.model": {
        "provider": "zhipu",
        "model": "glm-4.7"
    },
    // GCMP 内置视觉分析模型（必须支持图像输入）
    "gcmp.vision.model": {
        "provider": "zhipu",
        "model": "glm-4.6v"
    }
}
```

> 推荐规格：`utilitySmallModel` 选择响应快的模型（如 `deepseek-v4-flash`），可配合 `maxInputTokens: 16384` 等低规格满足快捷任务即可。通用任务（标题生成、摘要等）使用 `chat.utilityModel`。
>
> 在 `settings.json` 中编辑时，将光标置于值位置，使用 VS Code 智能提示从已注册的模型中选择即可。**若未配置**这些设置，VS Code 会使用 Copilot 内置模型执行实用任务，**这可能会消耗免费用户的 Copilot 月度额度**。推荐配置为 GCMP 模型，可避免实用任务占用 Copilot 配额。
>
> 也可通过命令面板执行 `GCMP: 设置辅助工具模型`，在可视化面板中统一配置上述所有模型。
>
> 入口快捷方式：悬停状态栏的 Token 消耗图标，在弹出的每日统计底部文本菜单中点击「设置辅助工具模型」即可进入同一面板。

- `chat.utilitySmallModel`：轻量实用任务模型（默认 `gpt-4o-mini`）。覆盖 `chat-title`（标题）、`git-commit-message`（提交信息）、`git-branch-name`（分支名）、`inline-progress-message`（进度消息）、`prompt-categorizer`（意图分类）、`todo-tracker`（待办跟踪）、`rename-suggestions`（重命名建议）、`terminal-command/quickfix/explain`（终端命令/修复/解释）、`workspace-search`（搜索助手）。
- `chat.utilityModel`：通用实用任务模型（默认 CAPI fallback）。覆盖 `settings-resolver`（设置搜索）、`explain-code`（代码解释）、`vscode-qa`（VS Code 问答）。
- `inlineChat.defaultModel`：内联聊天（Inline Chat）默认模型，用于编辑器内联对话（`Ctrl+I` / 右键 "在行内聊天"）。
- `chat.exploreAgent.defaultModel`：Explore 子 Agent 默认模型，用于 `search-subagent` 代码库探索与搜索。
- `chat.planAgent.defaultModel`：Plan 子 Agent 默认模型，用于 Agent 模式中的方案规划与任务拆解。
- `github.copilot.chat.askAgent.model`：Ask Agent 默认模型，用于 Ask 模式问答。
- `github.copilot.chat.implementAgent.model`：Implement Agent 默认模型，用于 Implement 模式代码实现。
- `github.copilot.chat.exploreAgent.model`：Explore Agent 默认模型，用于 Explore 模式代码库探索。
- `gcmp.commit.model`：GCMP 内置提交消息生成模型。
- `gcmp.vision.model`：GCMP 内置视觉分析模型，必须选择支持图像输入的模型。

</details>

## 🤖 内置的AI大模型提供商

> 本扩展仅预置存在自有模型的一线大模型提供商（如具备模型自研能力的主流云厂商），第三方模型接入请使用「OpenAI / Anthropic Compatible」兼容模式。

### [**智谱AI**](https://bigmodel.cn/) - ZhipuAI

- [**编程套餐**](https://bigmodel.cn/glm-coding)：**GLM-5.2**、**GLM-5V-Turbo**、**GLM-5-Turbo**、**GLM-4.7**、**GLM-4.6**、**GLM-4.6V**
    - **用量查询**：已支持状态栏显示周期剩余用量，可查看 GLM Coding Plan 用量信息。
- **按量计费(PayGo)**：**GLM-5.2**、**GLM-5.1**(极速版)、**GLM-5V-Turbo**、**GLM-5-Turbo**、**GLM-5**、**GLM-4.7**、**GLM-4.7-FlashX**、**GLM-4.6**、**GLM-4.6V**
- **免费模型**：**GLM-4.6V-Flash**
- [**国际站点**](https://z.ai/model-api)：已支持国际站(z.ai)切换设置。
- **搜索功能**：集成 `联网搜索MCP` 及 `Web Search API`，支持 `#zhipuWebSearch` 进行联网搜索。
    - 默认启用 `联网搜索MCP` 模式，编程套餐支持：Lite(100次/月)、Pro(1000次/月)、Max(4000次/月)。
    - 可通过设置关闭 `联网搜索MCP` 模式以使用 `Web Search API` 按次计费。

### [**MiniMax**](https://platform.minimaxi.com/login)

- [**Token Plan 套餐**](https://platform.minimaxi.com/subscribe/token-plan)：**MiniMax-M3**、**MiniMax-M2.7**(极速版)、**MiniMax-M2.5**(极速版)、**MiniMax-M2.1**、**MiniMax-M2**
    - **搜索功能**：集成 Token Plan 联网搜索工具，支持通过 `#minimaxWebSearch` 进行联网搜索。
    - **用量查询**：已支持状态栏显示周期剩余用量，可查看 Token Plan 套餐用量信息。
    - **[国际站点](https://platform.minimax.io/subscribe/token-plan)**：已支持国际站 Token Plan 套餐使用。
- **按量计费(PayGo)**：**MiniMax-M3**、**MiniMax-M2.7**(极速版)、**MiniMax-M2.5**(极速版)、**MiniMax-M2.1**、**MiniMax-M2**

### [**MoonshotAI**](https://platform.kimi.com/)

- [**会员权益**](https://www.kimi.com/coding)：Kimi `会员计划` 套餐的附带的 `Kimi For Coding` (HighSpeed)。
    - **搜索功能**：集成 Kimi Search 联网搜索工具，支持通过 `#kimiWebSearch` 进行联网搜索。
    - **用量查询**：已支持状态栏显示周期剩余用量，可查看套餐的剩余用量及限频重置时间。
- 预置模型(PayGo)：**Kimi K2.5**、**Kimi K2.6**、**Kimi K2.7 Code**(极速版)
    - **余额查询**：已支持状态栏显示当前账户额度，可查看账户余额状况。

### [**DeepSeek**](https://platform.deepseek.com/)

- 预置模型：**DeepSeek-V4-Flash**(快速模式)、**DeepSeek-V4-Pro**(专家模式)
    - **余额查询**：已支持状态栏显示当前账户额度，可查看账户余额详情。

### [**阿里云百炼**](https://bailian.console.aliyun.com/) - AliDashScope

- [**Coding Plan**](https://www.aliyun.com/benefit/scene/codingplan)
    - 推荐模型：**Qwen3.6-Plus**、**Kimi-K2.5**、**GLM-5**、**MiniMax-M2.5**
    - 更多模型：**Qwen3.5-Plus**、**Qwen3-Max**、**Qwen3-Coder-Next**、**Qwen3-Coder-Plus**、**GLM-4.7**
- [**Token Plan**](https://www.aliyun.com/benefit/scene/tokenplan)：**Qwen3.7-Max**、**Qwen3.6-Plus**、**Qwen3.6-Flash**、**GLM-5.2**、**GLM-5.1**、**GLM-5**、**Kimi-K2.7-Code**、**Kimi-K2.6**、**Kimi-K2.5**、**MiniMax-M2.5**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**、**DeepSeek-V3.2**
- **通义千问系列**：**Qwen3.7-Plus**、**Qwen3.7-Max**、**Qwen3.6-Max**、**Qwen3.6-Plus**、**Qwen3.6-Flash**、**Qwen3.5-Plus**、**Qwen3.5-Flash**
- **DeepSeek-V4**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**
- **其他按量计费**：**GLM-5.2**、**Kimi-K2.7-Code**
- **搜索功能**：集成 [联网搜索MCP](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3023217) 工具（2000次/月），支持通过 `#bailianWebSearch` 进行联网搜索。（使用[阿里云百炼ApiKey](https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key)而非编程套餐的ApiKey）

### [**快手万擎**](https://streamlake.com/product/kat-coder) - StreamLake

- [**KwaiKAT Coding Plan**](https://streamlake.com/marketing/coding-plan)：**KAT-Coder-Pro-V2**
- **KAT-Coder系列**：**KAT-Coder-Pro-V2**(PayGo)

### [**火山方舟**](https://www.volcengine.com/product/ark) - Volcengine

- [**Coding Plan 套餐**](https://www.volcengine.com/activity/codingplan)：
    - 豆包模型：**Ark-Code-Latest**(Auto)、**Doubao-Seed-2.0-Code**、**Doubao-Seed-Code**、**Doubao-Seed-2.0-lite**、**Doubao-Seed-2.0-pro**
    - 开源模型：**GLM-5.2**、**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**Kimi-K2.7-Code**、**Kimi-K2.6**、**MiniMax-M3**、**MiniMax-M2.7**
- [**Agent Plan 套餐**](https://www.volcengine.com/activity/agentplan)：
    - 豆包模型：**Ark-Code-Latest**(Auto)、**Doubao-Seed-2.0**(Code/pro/lite/mini)
    - 开源模型：**GLM-5.2**、**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**Kimi-K2.7-Code**、**Kimi-K2.6**、**MiniMax-M3**、**MiniMax-M2.7**
- **豆包系列**：**Doubao-Seed-Evolving**、**Doubao-Seed-2.1**(turbo/pro)、**Doubao-Seed-2.0**(lite/mini/pro/Code)、**Doubao-Seed-1.8**
- **协作奖励计划**：**GLM-4.7**、**DeepSeek-V3.2**
- **按量计费(PayGo)**：**DeepSeek-V4-Flash-260425**、**DeepSeek-V4-Pro-260425**
- **密钥配置**：支持设置 [Coding Plan API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) 与 [Agent Plan 专用 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan) 分别设置，配置向导引导选择套餐类型。

### [**腾讯云**](https://cloud.tencent.com/product/hunyuan) - Tencent

- [**Coding Plan**](https://console.cloud.tencent.com/tokenhub/codingplan)
    - 开源模型：**GLM-5**、**Kimi-K2.5**、**MiniMax-M2.5**
- [**Token Plan**](https://console.cloud.tencent.com/tokenhub/tokenplan)：**HY 3 Preview**、**GLM-5.1**、**GLM-5**、**Kimi-K2.5**、**MiniMax-M2.7**、**MiniMax-M2.5**、**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**
- [**TokenHub**](https://console.cloud.tencent.com/tokenhub/models)：
    - **GLM 系列**：**GLM-5.2**、**GLM-5.1**、**GLM-5V-Turbo**、**GLM-5-Turbo**、**GLM-5**
    - **DeepSeek 系列**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**DeepSeek-V3.2**
    - **Kimi 系列**：**Kimi-K2.7-Code**、**Kimi-K2.6**、**Kimi-K2.5**
    - **MiniMax 系列**：**MiniMax-M3**、**MiniMax-M2.7**、**MiniMax-M2.5**
    - **Hunyuan 系列**：**HY 3 Preview**、**Tencent HY 2.0 Instruct**、**Tencent HY 2.0 Think**
- **密钥配置**：腾讯云API密钥分为 [腾讯云付费模型 API Key](https://hunyuan.cloud.tencent.com/#/app/apiKeyManage)、[Coding Plan 专用 API Key](https://console.cloud.tencent.com/tokenhub/codingplan)、[Token Plan 专用 API Key](https://console.cloud.tencent.com/tokenhub/tokenplan)、[DeepSeek 专用 API Key](https://console.cloud.tencent.com/lkeap/api)、[TokenHub 付费 API Key](https://console.cloud.tencent.com/tokenhub/apikey)，需要进入正确的密钥获取界面生成密钥。

### [**Xiaomi MiMo**](https://platform.xiaomimimo.com/#/console/api-keys)

- **按量计费(PayGo)**：**MiMo-V2.5-Pro**(UltraSpeed)、**MiMo-V2.5**
- [**Token Plan**](https://platform.xiaomimimo.com/#/token-plan)：**MiMo-V2.5-Pro**、**MiMo-V2.5**
    - [区域集群](https://platform.xiaomimimo.com/#/docs/tokenplan/subscription?target=快速指南)：可切换选择`中国集群(cn)`、`新加坡集群(sgp)`、`欧洲集群(ams)`，按[订阅管理](https://platform.xiaomimimo.com/#/console/plan-manage)页面展示为准。
- **密钥配置**：支持设置 [Xiaomi MiMo API Key](https://platform.xiaomimimo.com/#/console/api-keys) 与 [Token Plan 专用 API Key](https://platform.xiaomimimo.com/#/console/plan-manage) 分别设置。

### [**百度千帆**](https://cloud.baidu.com/product-s/qianfan_home) - Baidu Qianfan

- **按量计费(PayGo)**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**DeepSeek-V3.2**、**GLM-5.2**、**GLM-5.1**、**GLM-5**、**Kimi-K2.6**、**Kimi-K2.5**、**ERNIE-5.1**、**ERNIE-5.0**
- [**Coding Plan 编程套餐**](https://cloud.baidu.com/product/codingplan)：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**GLM-5.1**、**DeepSeek-V3.2**、**GLM-5**、**Kimi-K2.5**
- **密钥配置**：支持设置 [百度千帆 API Key](https://console.bce.baidu.com/qianfan/ais/console/apiKey) 与 [Coding Plan 专用 API Key](https://console.bce.baidu.com/qianfan/resource/subscribe) 分别设置。

### [**阶跃星辰**](https://platform.stepfun.com/?invite_code=VMQHFFSU) - StepFun

- [**Step Plan 套餐**](https://platform.stepfun.com/step-plan)：**Step-3.7-Flash**、**Step-3.5-Flash**、**Step-3.5-Flash-2603**、**Step-Router-V1**
- **按量计费(PayGo)**：**Step-3.7-Flash**、**Step-3.5-Flash**、**Step-3.5-Flash-2603**
- **搜索功能**：集成 `#stepfunWebSearch` MCP 联网搜索工具，支持 category 参数过滤。
    - Step Plan 套餐可使用 MCP 调用，非订阅套餐使用标准按次计费接口。

### [**蚂蚁百灵**](https://www.ant-ling.com/) - Ant Ling

蚂蚁集团开源的 MoE 架构大语言模型家族，采用 Anthropic 模式接入。

- **预置模型(PayGo)**：**Ling-2.6-1T**、**Ling-2.6-flash**、**Ring-2.6-1T**
- [**免费额度**](https://developer.ant-ling.com/zh-CN/docs/models/price/)：每日赠送 50 万免费 token（输入输出共享）。

### [**讯飞星辰**](https://maas.xfyun.cn/) - XunFei Astron

科大讯飞旗下大模型服务平台，采用 Anthropic SDK 模式接入，支持双套餐密钥管理。

- [**Coding Plan 编程套餐**](https://maas.xfyun.cn/packageSubscription)：**Spark X2**、**Spark-X2-Flash**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**、**DeepSeek-V3.2**、**GLM-5.2**、**GLM-5.1**、**GLM-5**、**GLM-4.7-Flash**、**Kimi-K2.6**、**Kimi-K2.5**、**MiniMax-M2.5**、**Qwen3.6-35B-A3B**、**Qwen3.5-35B-A3B**、**Qwen3.5-397B-A17B**、**Qwen3-Coder-Next-FP8**
- [**Token Plan 套餐**](https://maas.xfyun.cn/tokenPlan)：同样 16 款模型通过独立 Token Plan 端点提供。
- **密钥配置**：支持 [Coding Plan 专用密钥](https://maas.xfyun.cn/packageSubscription) 与 [Token Plan 专用密钥](https://maas.xfyun.cn/tokenPlan) 分别配置，配置向导引导选择套餐类型。

### [**LongCat**](https://longcat.chat/platform/) - LongCat

- **预置模型**：**LongCat-2.0** LongCat API 开放平台的 Agentic 模型，采用 Anthropic SDK 模式接入。

### CLI 编程工具 API 提供商

> 以下提供商本身是开源或商业的 AI 编程 CLI 工具（类似 Claude Code），开放了 API 接口供第三方调用其聚合的模型能力。

### [**OpenCode**](https://opencode.ai/)

- [**Go**](https://opencode.ai/go?ref=2TEVV934MY)：**GLM-5.2**、**GLM-5.1**、**Kimi-K2.7-Code**、**Kimi-K2.6**、**Kimi-K2.5**、**MiMo-V2.5**、**MiMo-V2.5-Pro**、**MiniMax-M3**、**MiniMax-M2.7**、**Qwen3.7-Max**、**Qwen3.7-Plus**、**Qwen3.6-Plus**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**
- **Zen**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**GLM-5**、**GLM-5.1**、**GLM-5.2**、**Kimi-K2.5**、**Kimi-K2.6**、**Qwen3.5-Plus**、**Qwen3.6-Plus**、**Grok-Build-0.1**、**MiniMax-M2.5**、**MiniMax-M2.7**

### [**Hyper**](https://hyper.charm.land/) - Charm Hyper

- **预置模型**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**、**Qwen3.7-Max**、**Qwen3.7-Plus**、**Qwen3.6-Plus**、**Qwen3.6-Max**、**Qwen3.6-Flash**、**Qwen3-Coder-480B-A35B-Instruct-INT4-Mixed-AR**、**Qwen3-Next-80B-A3B-Instruct**、**GLM-5.2**、**GLM-5.1**、**GLM-5**、**Kimi-K2.7-Code**、**Kimi-K2.6**、**Kimi-K2.5**、**MiniMax-M2.7**、**Llama-4-Maverick-17B-128E-Instruct-FP8**、**Llama-3.3-70B-Instruct**、**Gemma-4-26B-A4B**、**GPT-OSS-120B**

### [**ClinePass**](https://docs.cline.bot/getting-started/clinepass) - Cline 官方推出的模型订阅服务

- **预置模型**：**GLM-5.2**、**Kimi-K2.7-Code**、**Kimi-K2.6**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**、**MiMo-V2.5**、**MiMo-V2.5-Pro**、**MiniMax-M3**、**Qwen3.7-Max**、**Qwen3.7-Plus**
- **API Key**：在 [Cline App → API Keys](https://app.cline.bot/dashboard/account?tab=api-keys) 页面创建并复制 API Key，使用 `GCMP: 设置 ClinePass API 密钥` 命令配置。

### OAuth 认证编程助手提供商

> ⚠️ **风险警告**：以下提供商通过模拟官方 CLI 工具的 OAuth 身份验证方式来实现对应的 API 访问，**可能涉嫌滥用第三方服务条款，存在被官方检测封禁账号的风险**。请仅在确保知情并自愿承担风险的前提下使用。

### [**Codex CLI**](https://chatgpt.com/codex) - OpenAI Codex

OpenAI 官方编程助手 Codex 的命令行工具，支持通过 `codex` CLI 进行身份验证（需要本地安装 `codex` CLI）。

```bash
npm install -g @openai/codex@latest
```

- **支持模型**：**GPT-5.6**(Sol/Terra/Luna)、**GPT-5.5**、**GPT-5.4-mini**、**GPT-5.4**
- **用量查询**：已支持状态栏显示 ChatGPT 订阅周期剩余用量，可查看订阅余量信息。
- **独立代理设置**：Codex CLI 使用自己的代理配置（与扩展全局代理 `gcmp.proxy` 独立）。可通过 `gcmp.providerOverrides.codex.proxy` 单独指定 Codex 请求的代理地址。

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

xAI 官方 Grok Build 编程助手命令行工具，支持通过 `grok` CLI 进行 OAuth 身份验证（需要本地安装 Grok Build CLI）。

```bash
# macOS / Linux
curl -fsSL https://x.ai/cli/install.sh | bash

# Windows PowerShell
irm https://x.ai/cli/install.ps1 | iex
```

- **支持模型**：**Grok 4.5**、**Grok Build 0.1**、**Grok Composer 2.5 (fast)**

## ⚙️ 高级配置

GCMP 支持通过 VS Code 设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

> 📝 **提示**：`settings.json` 所有参数修改会立即生效。

<details>
<summary>展开查看高级配置说明</summary>

### 通用模型参数 及 额外支持功能 配置

```json
{
    "gcmp.retry.enabled": true, // 启用自动重试（默认 true），关闭后请求失败直接停止
    "gcmp.retry.maxAttempts": 3 // 1-5，仅对可重试错误生效
}
```

- `gcmp.retry.enabled` 默认值为 `true`，开启后自动重试 429 等可重试错误。设为 `false` 可完全禁用重试，请求失败立即停止。
- `gcmp.retry.maxAttempts` 默认值为 `3`，用于控制 429、限流和临时过载类错误的最大自动重试次数。
- 当前重试延迟序列为 `1s → 3s → 6s → 10s → 15s`，达到上限后会直接抛出最后一次错误。
- `gcmp.maxTokens` **已弃用**：此设置不再生效，各模型现在自动使用自身的 `maxOutputTokens` 配置。

> 各功能专属设置（如 `gcmp.commit.enabled`、`gcmp.vision.model`、`gcmp.zhipu.search.enableMCP`）分别在其对应的功能章节中说明，不在此处展开。

#### 代理与系统证书配置

```json
{
    "gcmp.proxy": "http://127.0.0.1:7890", // 全局代理（可选），推荐使用完整 URL
    "gcmp.tls.useSystemCertificates": true // 追加系统根证书（默认开启）
}
```

- `gcmp.proxy` 会作为扩展内所有网络请求的默认代理，包括：聊天请求、FIM / NES 补全、联网搜索、MCP 客户端、状态栏余额/用量查询、Compatible Provider 的"获取模型"请求，以及 CLI OAuth 刷新请求。
- 代理优先级为：`model.proxy` → `gcmp.providerOverrides.<provider>.proxy` → `gcmp.providerOverrides.compatible.proxy`（仅非内置 provider） → `gcmp.proxy` → VS Code `http.proxy` → 环境变量（`HTTPS_PROXY` / `HTTP_PROXY`）→ **系统代理（自动检测）**。
- 代理地址支持 `host:port` 简写（如 `127.0.0.1:7890`），但推荐使用完整 URL，如 `http://127.0.0.1:7890`。
- 填写 `noproxy` 可显式绕过所有代理（包括系统代理和已配置代理），且在代理链路上任一层次设为 `noproxy` 时立即短路，不再继续回退。
- 当无显式代理配置时，扩展会自动检测 Windows 注册表或 macOS `scutil` 中的系统代理设置并自动沿用。
- > ⚠️ 不支持 PAC (Proxy Auto-Config) 代理协议。若系统代理设为 PAC，扩展将忽略该配置，需要时请改为显式代理地址。
- `gcmp.tls.useSystemCertificates` 用于将操作系统信任的根证书追加到 Node.js 默认 CA 列表，适合企业代理、内网网关或本地安装自签根证书场景。
- 支持带认证的代理 URL，日志中会自动脱敏用户名和密码。

**配置示例**：

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

#### 提供商配置覆盖

GCMP 支持通过 `gcmp.providerOverrides` 配置项来覆盖提供商的默认设置，包括 `baseUrl`、`proxy`、`customHeader` 等。

**支持范围因提供商类型而异**：

| 提供商类型                                             | 支持覆盖的字段                                 | models[]                                |
| ------------------------------------------------------ | ---------------------------------------------- | --------------------------------------- |
| **内置提供商**（deepseek/zhipu 等）                    | `baseUrl`、`customHeader`、`proxy`、`models[]` | ✅ 支持新增和覆盖模型                   |
| **已知提供商**（aihubmix/openrouter 等）               | `customHeader`、`proxy`                        | ❌ 不支持（走 `gcmp.compatibleModels`） |
| **自定义提供商**（compatibleModels 中自定义 provider） | `customHeader`、`proxy`                        | ❌ 不支持（走 `gcmp.compatibleModels`） |
| **compatible** 自身                                    | `customHeader`、`proxy`                        | ❌ 不支持（走 `gcmp.compatibleModels`） |

已知/自定义/compatible 提供商不支持 `models[]`，模型定义统一通过 `gcmp.compatibleModels` 配置。

**配置优先级**：

```
模型自身设置 > providerOverrides.{provider} > providerOverrides.compatible
```

- `providerOverrides.compatible` 作为全局默认值，对所有 Compatible Provider 下的模型生效
- 代理地址：`model.proxy` > `providerOverrides.{provider}.proxy` > `providerOverrides.compatible.proxy`（仅非内置 provider） > `gcmp.proxy` > VS Code `http.proxy` > 环境变量
- 自定义 HTTP 头：`providerOverrides.{provider}.customHeader` > 模型自身 `customHeader` > `providerOverrides.compatible.customHeader`

**配置示例**：

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "proxy": "http://127.0.0.1:7890", // 可选：提供商级默认代理
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
        },
        "aihubmix": {
            "proxy": "http://127.0.0.1:7890", // 已知或自定义提供商也支持代理覆盖
            "customHeader": { "X-Custom": "value" }
        },
        "compatible": {
            "proxy": "http://127.0.0.1:7890" // 全局默认代理，所有 Compatible Provider 模型生效
        }
    }
}
```

</details>

## 🔌 Compatible 自定义模型支持

GCMP 提供 **Compatible Provider**，用于支持任何 OpenAI 或 Anthropic 兼容的 API。通过 `gcmp.compatibleModels` 配置，您可以完全自定义模型参数，包括扩展请求参数。

1. 通过 `GCMP: Compatible Provider 设置` 命令启动配置向导。
2. 在 `settings.json` 设置中编辑 `gcmp.compatibleModels` 配置项。

<details>
<summary>展开查看自定义模型配置说明</summary>

### 自定义模型内置已知提供商ID及显示名称列表

> 聚合转发类型的提供商可提供内置特殊适配，不作为单一提供商提供。<br/>
> 若需要内置或特殊适配的请通过 Issue 提供相关信息。<br/>
> 已知提供商支持通过 `gcmp.providerOverrides.{providerId}` 覆盖 `customHeader`、`proxy`。

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
            // "proxy": "http://127.0.0.1:7890", // 可选：仅对该模型生效，也用于“获取模型”探测请求
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

- `gcmp.compatibleModels[*].proxy` 仅作用于当前自定义模型；在填写 `baseUrl` 后点击“获取模型”时，也会使用同一代理设置进行探测。

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

### 自定义 provider 余额/用量查询示例：`usage` + `usages` 智能合并

对于 `Compatible` 自定义 provider，可在 `gcmp.providerOverrides.{providerId}` 下配置：

- `usage`：可选；单一余额查询时只配置它即可，也可作为 `usages` 的公共默认值
- `usages`：可选；仅在需要多个命名金额/余额查询模式时使用，每个条目都可在 `usage` 基础上增量覆盖

也就是说：

- 只配置 `usage`：就是单一余额查询
- 需要多个查询模式时：再通过 `usages` 做多金额/多余额覆盖查询
- `usage` 和 `usages` 都不配置：就不会注册该自定义 provider 的余额/用量查询

内置已知 provider 的 `usage` / `usages` 参考配置方式，可直接查看源码 [src/utils/knownProviders.ts](src/utils/knownProviders.ts)。

> 注意：`gcmp.providerOverrides` 的 provider key 必须与 `gcmp.compatibleModels[*].provider` **完全一致**，包括大小写。
>

例如，下面这个更贴近实际 `settings.json` 的 [NekoCode](https://nekocode.ai?aff=U9XPRBID) 相关配置片段表示：

- `gcmp.compatibleModels` 下有多个模型共用同一个 `provider: "NekoCode"`
- `gcmp.providerOverrides.NekoCode.usage` 提供默认查询 URL `https://api2.nekoapi.ai/v1/usage` 和公共字段路径 `balance`
- `gcmp.providerOverrides.NekoCode.usages.pay` 与 `usage` 的最终查询配置等价，只额外提供显示名称 `余额`
- `gcmp.providerOverrides.NekoCode.usages.sub` 复用 `usage.fields.balance`，但把查询 URL 覆盖为 `https://api2.nekoapi.ai/v1/user/balance`

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
                    "displayName": "余额",
                    "url": "https://api2.nekoapi.ai/v1/usage"
                },
                "sub": {
                    "displayName": "订阅",
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

该配置的实际效果是：

- `providerOverrides.NekoCode` 会同时作用于所有 `provider: "NekoCode"` 的兼容模型，例如上面的 `GPT-5.4 (NekoCode)` 和 `GPT-5.5 (NekoCode)`
- `pay` 会继承 `usage.fields.balance = "balance"`
- `sub` 也会继承 `usage.fields.balance = "balance"`
- 因为 `pay` 与 `usage` 解析出的查询配置等价，所以不会再额外生成一个重复的 `default` 模式

最终状态栏会按两个命名模式进行查询与展示：

- `NekoCode / 余额`
- `NekoCode / 订阅`

</details>

## 💡 FIM / NES 内联补全建议功能

- **FIM**：根据上下文预测并补全光标处缺失的代码，适合单行/短片段补全。
- **NES**：基于编辑上下文提供智能代码建议，支持多行代码生成。

> **使用前必读**：需先在对话模型中配置并验证 ApiKey；在输出面板选择 `GitHub Copilot Inline Completion via GCMP` 可查看调试信息。接入的是通用大模型，**未针对代码补全专门训练**，效果可能不及 Copilot 原生 Tab 补全。

<details>
<summary>展开查看详细配置说明</summary>

### FIM / NES 内联补全建议模型配置

FIM 和 NES 补全都使用单独的模型配置，可以分别通过 `gcmp.fimCompletion.modelConfig` 和 `gcmp.nesCompletion.modelConfig` 进行设置。

> **代理配置**：FIM 和 NES 支持通过 `proxy` 字段单独设置代理地址（如 `http://127.0.0.1:7890`），方便在不同网络环境下调试。支持带认证的代理，日志中会自动脱敏用户凭据。

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
        // "proxy": "http://127.0.0.1:7890", // 可选：单独设置代理地址
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
        // "proxy": "http://127.0.0.1:7890", // 可选：单独设置代理地址
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
        // "proxy": "http://127.0.0.1:7890", // 可选：单独设置代理地址
        "model": "codestral-latest",
        "extraBody": { "code_annotations": null },
        "maxTokens": 100
    }
}
```

### 熔断器（Circuit Breaker）

FIM 与 NES 补全请求连续失败时，熔断器会暂时停止请求，避免无限重试浪费资源和费用。

**三态模型**：

| 状态      | 说明                                                                   |
| --------- | ---------------------------------------------------------------------- |
| **Closed**  | 正常通行，请求通过并累计失败次数                                       |
| **Open**    | 熔断断开，拒绝所有请求，进入冷却倒计时                                 |
| **HalfOpen** | 冷却结束后允许一次探测请求，成功则恢复 Closed，失败则重新熔断 Open     |

**工作流程**：

1. 请求连续失败达到 `failureThreshold` 后，熔断器从 Closed → Open
2. Open 状态下所有请求被立即拒绝，等待 `cooldownSeconds` 秒冷却
3. 冷却结束后首次 `allowRequest()` 进入 HalfOpen，发放一次探测请求
4. 探测成功（`recordSuccess()`）→ 回到 Closed，恢复服务
5. 探测失败（`recordFailure()`）→ 回到 Open，重新冷却。**每冷却周期只重试一次**（默认每 30 秒一次），直到成功或用户手动「立即重试」
6. 请求被用户取消（`recordCancellation()`）→ 不消耗 HalfOpen 探测名额，可重新探测

**熔断通知**：Open 状态首次触发时弹出通知提示（30 秒内不重复），支持「立即重试」恢复服务或「查看设置」跳转配置页。

**配置项**：

```json
{
    // FIM 熔断器配置（默认启用）
    "gcmp.fimCompletion.circuitBreaker": {
        "enabled": true,            // 启用熔断
        "failureThreshold": 10,     // 默认 10，范围 2-60
        "cooldownSeconds": 30       // 默认 30，范围 10-300
    },
    // NES 熔断器配置（默认启用）
    "gcmp.nesCompletion.circuitBreaker": {
        "enabled": true,            // 启用熔断
        "failureThreshold": 5,      // 默认 5，范围 2-20
        "cooldownSeconds": 30       // 默认 30，范围 10-300
    }
}
```

> 配置修改即时生效，无需重启 VS Code。

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
- **请求来源分类**：记录并显示每次请求的 Copilot 请求类型（如主 Agent、标题生成、提交消息、搜索子 Agent、视觉识别等），便于追踪后台实用任务的实际消耗
- **实时请求指标**：流式阶段实时展示首流延迟（TTFT）与输出耗时（TPOT），完成后由真实 usage 自然刷新
- **实时输出 token 估算**：流式阶段基于 tokenizer 实时估算输出 token 与输出速度（tokens/s），输出列以"最近一次接收的预估增量"（`+xx tks`）形式展示，完成后由真实 usage 覆盖
- **缓存命中率可视化**：输入列合并展示缓存命中数与输入总数，并显示缓存命中率，帮助判断缓存策略效果

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

为避免将无关噪音或潜在敏感内容发送给模型，Commit 消息生成功能会在分析 diff 前做一层过滤：

- 自动省略 lockfile / snapshot 的大段 diff 内容，例如 `package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`bun.lockb`、`*.snap`
- 自动跳过常见敏感文件，例如 `.env*`、证书/私钥文件、`.aws` / `.ssh` / `.gnupg` / `.docker` 目录下的文件
- 支持通过 `gcmp.commit.sensitiveFiles` 追加你自己的敏感文件匹配规则

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
    "gcmp.commit.enabled": true, // 启用内置提交消息生成功能（默认 true，将在下个主版本移除）
    "gcmp.commit.language": "chinese", // 生成语言：chinese / english（auto 模式语言不明确时的回退值）
    "gcmp.commit.format": "auto", // 提交消息格式：auto(默认) / 见下方 format 说明
    "gcmp.commit.customInstructions": "", // 自定义指令（仅当 format=custom 时生效）
    "gcmp.commit.sensitiveFiles": ["*.pem", "**/.env.local", "secrets/**"], // 额外排除在 diff 分析之外的敏感文件路径模式
    "gcmp.commit.model": {
        "provider": "zhipu", // 生成模型的提供商（providerKey，例如 zhipu / minimax / compatible）
        "model": "glm-4.6" // 生成模型的 ID（对应 VS Code Language Model 的 model.id）
    }
}
```

### `gcmp.commit.sensitiveFiles` 过滤规则说明

`gcmp.commit.sensitiveFiles` 用于补充内置敏感文件过滤规则。它接收一组简单的类 glob 字符串：

- `*.pem`：匹配任意 `.pem` 文件
- `**/.env.local`：匹配任意目录下的 `.env.local`
- `secrets/**`：匹配 `secrets/` 目录下的所有文件
- `**/private/*.key`：匹配任意 `private` 目录下的 `.key` 文件

命中后，该文件不会参与 Commit diff 分析，也不会被发送给模型用于生成提交消息。

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

## 👁️ 视觉分析工具

GCMP 内置一组专用视觉分析工具，用于把图片/截图转换为可直接落地的开发产物、提取文字、诊断错误、理解技术图纸、分析数据可视化以及对比 UI 差异。所有视觉分析完全委托给原生支持多模态的 GCMP 模型，不依赖第三方 MCP 后端。

<details>
<summary>展开查看视觉分析工具详细说明</summary>

### 工具列表

| 工具引用                          | 用途                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `#gcmpUiToArtifact`               | 将 UI 截图转换为前端代码、AI 提示词、设计规范或自然语言描述 |
| `#gcmpExtractTextFromScreenshot`  | 从截图中提取和识别文字（OCR），支持代码、终端输出、文档等   |
| `#gcmpDiagnoseErrorScreenshot`    | 分析错误弹窗、堆栈和异常截图，定位根因并给出修复建议        |
| `#gcmpUnderstandTechnicalDiagram` | 分析架构图、流程图、UML、ER 图和系统设计图                  |
| `#gcmpAnalyzeDataVisualization`   | 从图表、图形和仪表盘中提取趋势、异常和可操作建议            |
| `#gcmpUiDiffCheck`                | 对比预期/参考 UI 截图与实际实现截图，识别视觉差异和实现偏差 |
| `#gcmpAnalyzeImage`               | 通用图像分析，适配未被专项工具覆盖的视觉内容                |

### 使用方式

视觉工具通过 `#` 引用调用，例如 `#gcmpUiToArtifact`。调用时可直接粘贴图片、截图或引用图片文件路径，模型会基于图片内容生成对应产物或分析结果。所有工具共用同一个视觉分析模型配置。

### 配置视觉分析模型

视觉工具依赖 `gcmp.vision.model` 指定的多模态模型。首次调用视觉工具时若未配置，会自动拉起选择向导；也可手动运行命令 `GCMP: 选择视觉分析模型`，或通过 `GCMP: 设置辅助工具模型` 面板统一配置。

```json
{
    "gcmp.vision.model": {
        "provider": "zhipu",
        "model": "glm-4.6v"
    }
}
```

- 所选模型必须支持图像输入能力（`capabilities.imageInput: true`）。
- 支持选择内置提供商模型、已配置图像输入能力的 Compatible Provider 模型，也支持选择 GitHub Copilot 原生多模态模型（将 `provider` 设为 `copilot`，`model` 设为 Copilot 模型 ID）。
- 未配置时首次调用会自动引导选择模型，无需提前手动填写 JSON。

</details>

## 🔑 API Key 跨设备同步

GCMP 提供基于 **GitHub Secret Gist** 的 API Key 跨设备同步功能，支持在同一 GitHub 账号的不同设备之间同步 API 密钥，无需手动逐一配置。

### 如何使用

鼠标悬停状态栏 Token 消耗图标，点击 tooltip 底部的「管理/同步 API Key」快速进入，或通过 VS Code 命令面板执行 `GCMP: 管理/同步 API Key`。

| 分组         | 操作                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| **同步操作** | **上传到 Gist** — 加密上传至 GitHub Gist / **从 Gist 下载** — 恢复到本地                    |
| **密钥管理** | **管理本地密钥** — 查看和删除本地 API Key / **管理云端密钥** — 查看和删除 Gist 中的 API Key |
| **安全设置** | **设置/更改口令** / **清除口令** — 管理自定义加密口令                                       |

> 上传 / 下载时支持**按提供商选择并显示一致性状态**（新增/更新/无需变更）。上传时新增和待更新的默认勾选；下载时与本地一致的项默认不勾选。部分上传不会覆盖远端未选中的密钥。

<details>
<summary>查看详细加密原理与安全说明</summary>

### 存储原理

| 层级         | 说明                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| **远端存储** | GitHub **Secret Gist**（私有 Gist），文件名为 `gcmp-sync.json`                          |
| **加密算法** | **AES-256-GCM**（认证加密，保证机密性 + 完整性）                                        |
| **密钥派生** | **scrypt**（N=16384, r=8, p=1），输入为 `GitHub 用户 ID + 固定 pepper + 可选自定义口令` |
| **认证方式** | VS Code 内置 **GitHub OAuth**，通过 `vscode.authentication` API 获取 token              |
| **认证复用** | 首次授权 `gist` scope；后续操作静默复用已授权 session                                   |

### 加密流程

```
GitHub 数字ID + pepper + [自定义口令] → scrypt(N=16384, r=8, p=1) → AES-256 密钥
                                                                       ↓
 每个 API Key → 随机 Salt(32B) + 随机 IV(16B) → AES-256-GCM 加密 → Salt+IV+Tag+密文 → JSON
```

- 每条密钥加密时使用**独立的随机盐值和初始向量**，相同明文每次加密结果不同
- 加密后的数据包包含 `Salt`、`IV`、`Tag`（认证标签）和 `密文`，全部以十六进制字符串编码
- **解密依赖于 GitHub 用户数字 ID**：同一 GitHub 账号在不同设备上登录，派生出的加密密钥相同，因此可以互相解密

### 自定义加密口令

> 由于扩展是**开源项目**，加密方式（pepper、scrypt 参数等）均可在源码中直接查看。如果希望额外加强保护，可以设置自定义加密口令。

- 在同步菜单中选择「设置加密口令」即可添加，输入两次确认
- 口令与 GitHub 用户 ID、pepper 共同参与密钥派生，三者缺一不可（最少 8 个字符）
- **口令更改后，之前用旧口令加密的数据将无法再解密**（派生密钥不同）
- 口令通过 VS Code `SecretStorage` 存储在本地（操作系统级加密），不会上传到任何服务器
- 同一 GitHub 账号的不同设备需设置**相同的口令**才能互相解密

#### 下载时的口令验证

下载时如果本地口令与上传时不匹配，会自动弹出提示：

- **已设置口令但无法解密** → 提示口令可能已更改，引导输入之前使用的口令
- **未设置口令但数据无法解密** → 提示数据可能在其他设备上用口令加密过，引导输入
- 输入口令后自动验证：解密成功则自动存储正确口令，后续下载无需再次输入
- 若只有部分密钥能解密，会提示数量不匹配

#### 跨设备提示

设置口令时会弹出提示，告知多设备同步需要所有设备使用相同口令：

- **首次设置**：提示请牢记口令并在所有设备上设置
- **更改口令**：提示更改后需在所有设备上同步更新

#### 数据兼容性

- 已有 Gist 数据时设置/更改口令，可选择**「设置并重新上传」**直接进入上传流程，避免遗漏
- 清除口令时需确认，清除后现有加密数据将无法再解密

### 安全说明

- Gist 会暴露在用户的 Gist 列表中，但内容经过 **AES-256-GCM 加密**，未经解密不可读
- 加密密钥不在网络中传输
- 本地 API Key 通过 VS Code `SecretStorage` 存储，操作系统级加密保护
- 所有网络请求均通过 HTTPS

</details>

---

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
