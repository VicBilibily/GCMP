# GCMP - 提供多个国内原生大模型提供商支持的扩展

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![Version](https://img.shields.io/visual-studio-marketplace/v/vicanent.gcmp?color=blue&label=Version)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/vicanent.gcmp?color=yellow&label=Installs)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/vicanent.gcmp?color=green&label=Downloads)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![License](https://img.shields.io/github/license/VicBilibily/GCMP?color=orange&label=License)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内主流原生大模型提供商，为开发者提供更加丰富、更适合本土需求的 AI 编程助手选择。目前已内置支持 智谱AI、Kimi、火山方舟、MiniMax、Moonshot AI、DeepSeek、快手万擎、阿里云百炼、百灵大模型 等**原生大模型**提供商。此外，扩展插件已适配支持 OpenAI 与 Anthropic 的 API 接口兼容模型，支持自定义接入任何提供兼容接口的第三方**云服务模型**。

#### EOL 内置提供商结束支持计划

> 即将移除及已经移除的提供商均支持通过 OpenAI / Anthropic Compatible 自定义模型添加使用。

- **ModelScope魔搭社区**
    - 2025-12-11 移除内置：此提供商仅适用于测试，各模型提供的 推理 API-Inference 接口不定时关闭服务。
- **心流AI**
    - 2025-12-31 移除内置：官方已专注于完善 `iFlow CLI`，免费服务已不再新增模型，存量模型亦在逐步下线。

## 🚀 快速开始

### 1. 安装扩展

在VS Code扩展市场搜索 `GCMP` 并安装，或使用扩展标识符：`vicanent.gcmp`

### 2. 开始使用

1. 打开 `VS Code` 的 `GitHub Copilot Chat` 面板
2. 在模型选择器的底部选择 `管理模型`，从弹出的模型提供商列表中选择所需的提供商
3. 若第一次使用，选择提供商后会要求设置 ApiKey，根据提示完成API密钥配置后，即可返回模型选择器添加并启用模型
4. 在模型选择器中选中目标模型后，即可开始与AI助手进行对话

## 🤖 内置的AI大模型提供商

### [**智谱AI**](https://bigmodel.cn/) - GLM系列

- [**编程套餐**](https://bigmodel.cn/glm-coding)：**GLM-4.6**(Thinking)、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5V**
- **按量计费**：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5V**
- **免费版本**：**GLM-4.5-Flash**
- **搜索功能**：集成 `联网搜索MCP` 及 `Web Search API`，支持 `#zhipuWebSearch` 进行联网搜索。
    - 默认启用 `联网搜索MCP` 模式，编程套餐支持：Lite(100次/月)、Pro(1000次/月)、Max(4000次/月)。
    - 可通过设置关闭 `联网搜索MCP` 模式以使用 `Web Search API` 按次计费。

### [**Kimi**](https://www.kimi.com/) - Kimi For Coding

- Kimi `会员计划` 套餐的附带的 `Kimi For Coding`，当前使用 Anthropic SDK 请求。
    - **用量查询**：已支持状态栏显示周期剩余额度，可查看赠送的每周剩余用量及每周重置时间。

### [**火山方舟**](https://www.volcengine.com/product/ark) - 豆包大模型

- [**Coding Plan 套餐**](https://www.volcengine.com/activity/codingplan)：**Doubao-Seed-Code**、**DeepSeek-V3.2**(思考模式)
- **编程系列**：**Doubao-Seed-Code**
- **豆包系列**：**Doubao-Seed-1.6**、**Doubao-Seed-1.6-Lite**、**Doubao-Seed-1.6-Flash**、**Doubao-Seed-1.6-Thinking**、**Doubao-Seed-1.6-Vision**
- **协作奖励计划**：**DeepSeek-V3.2**(思考模式)、**DeepSeek-V3.1-terminus**、**Kimi-K2-250905**、**Kimi-K2-Thinking-251104**(暂不输出思考内容)

### [**MiniMax**](https://platform.minimaxi.com/login)

- [**Coding Plan 编程套餐**](https://platform.minimaxi.com/subscribe/coding-plan)：**MiniMax-M2**
    - **搜索功能**：集成 Coding Plan 联网搜索调用工具，支持通过 `#minimaxWebSearch` 进行联网搜索。
    - **用量查询**：已支持状态栏显示周期使用比例，可查看 Coding Plan 编程套餐用量信息。
    - **[国际站点](https://platform.minimax.io/subscribe/coding-plan)**：已支持国际站 Coding Plan 编程套餐使用（`MiniMax-M2`、联网搜索、用量查询）。
- **按量计费**：**MiniMax-M2**、**MiniMax-M1**

### [**MoonshotAI**](https://platform.moonshot.cn/) - Kimi K2系列

- 预置模型：**Kimi-K2-0905-Preview**、**Kimi-K2-Turbo-Preview**、**Kimi-K2-0711-Preview**、**Kimi-Latest**
    - **余额查询**：已支持状态栏显示当前账户额度，可查看账户余额状况。
- 思考模型：**Kimi-K2-Thinking**、**Kimi-K2-Thinking-Turbo**
    - 多次工具调用后思考内容输出存在兼容性问题，暂时关闭思考内容输出

### [**DeepSeek**](https://platform.deepseek.com/) - 深度求索

- 预置模型：**DeepSeek-V3.2**(思考模式)、**DeepSeek-V3.2-Speciale**(Expires on 2025-12-15)
    - **余额查询**：已支持状态栏显示当前账户额度，可查看账户余额详情。

### [**快手万擎**](https://streamlake.com/product/kat-coder) - StreamLake

- **KAT-Coder系列**：**KAT-Coder-Pro-V1**、**KAT-Coder-Air-V1**

> 快手万擎 (KAT) StreamLake 需要手动创建 [`在线推理服务`](https://www.streamlake.com/document/WANQING/mdsosw46egl9m9lfbg) 后，在模型选择的快手万擎提供商设置中配置在线推理预置模型服务推理点ID方可使用。

### [**阿里云百炼**](https://bailian.console.aliyun.com/) - 通义大模型

- **通义千问系列**：**Qwen3-Max**、**Qwen3-VL-Plus**、**Qwen3-VL-Flash**、**Qwen-Plus**、**Qwen-Flash**

### [**百灵大模型**](https://ling.tbox.cn/open)

- **百灵系列**：**Ling-1T**、**Ring-1T**

### [**心流AI**](https://platform.iflow.cn/) - iFlow (EOL)

> - 由于 **iFlow** 已转移业务方向，主要支持 `iFlow CLI`，免费 API 接口已不再进行模型新增，免费接口的模型亦已开始逐步下线服务，故计划移除本插件的内置支持。
> - **EOL on 2025-12-31**：`心流AI` 目前仅提供 OpenAI 兼容 API 接口，若需继续使用仍在提供的免费模型服务，可自行添加 OpenAI 兼容 API 接口模型。

阿里巴巴旗下的的AI平台，当前[API调用](https://platform.iflow.cn/docs/)服务**免费使用**，目前[限流规则](https://platform.iflow.cn/docs/limitSpeed)为每个用户最多只能**同时发起一个**请求。

- **DeepSeek系列**：**DeepSeek-V3.2-Exp**、**DeepSeek-V3.1-Terminus**
- **Qwen3系列**：**Qwen3-Coder-Plus**、**Qwen3-Max**、**Qwen3-VL-Plus**、**Qwen3-Max-Preview**、**Qwen3-32B**、**Qwen3-235B-A22B**、**Qwen3-235B-A22B-Instruct**、**Qwen3-235B-A22B-Thinking**
- **Kimi系列**：**Kimi-K2-Instruct-0905**、**Kimi-K2**
- **智谱AI系列**：**GLM-4.6**

## 仅供测试体验的提供商

> 由于测试体验提供商可能存在兼容性问题，遇到问题建议先查看本地输出的日志排查后再提交 Issue 进一步处理。

### [**百度千帆**](https://console.bce.baidu.com/qianfan/overview)

- **文心大模型**：`ERNIE-5.0-Thinking`(Preview/Latest)、`ERNIE 4.5`(Turbo/Turbo VL)

### [**ModelScope**](https://www.modelscope.cn/) - (EOL)

> - 由于 **ModelScope** 作为模型分发测试平台，并不保证接口服务稳定性和持久性，API接口会随时调整，故不再提供内置支持。
> - **EOL on 2025-12-11**：`魔搭社区` 已经基本支持 Anthropic 兼容 API 接口，此兼容测试内置提供商将于 2025-12-11 移除内置支持。若需测试使用新模型可自行添加 Anthropic 兼容 API 接口模型。

## ⚙️ 高级配置

GCMP 支持通过 VS Code 设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

> 📝 **提示**：所有参数修改会立即生效。

### 配置AI模型参数

在 VS Code 设置中搜索 `"gcmp"` 或直接编辑 `settings.json`：

```json
{
    "gcmp.temperature": 0.1,
    "gcmp.topP": 1.0,
    "gcmp.maxTokens": 8192,
    "gcmp.editToolMode": "claude",
    "gcmp.rememberLastModel": true,
    "gcmp.zhipu.search.enableMCP": true
}
```

### 参数说明

#### 通用AI模型参数

| 参数                     | 类型    | 默认值 | 范围/选项         | 说明               |
| ------------------------ | ------- | ------ | ----------------- | ------------------ |
| `gcmp.temperature`       | number  | 0.1    | 0.0-2.0           | 输出随机性         |
| `gcmp.topP`              | number  | 1.0    | 0.0-1.0           | 输出多样性         |
| `gcmp.maxTokens`         | number  | 8192   | 32-32768          | 最大输出长度       |
| `gcmp.editToolMode`      | string  | claude | claude/gpt-5/none | 编辑工具模式       |
| `gcmp.rememberLastModel` | boolean | true   | true/false        | 记住上次使用的模型 |

#### 智谱AI专用配置

| 参数                          | 类型    | 默认值 | 说明                                 |
| ----------------------------- | ------- | ------ | ------------------------------------ |
| `gcmp.zhipu.search.enableMCP` | boolean | true   | 启用`联网搜索MCP`（Coding Plan专属） |

#### 提供商配置覆盖

GCMP 支持通过 `gcmp.providerOverrides` 配置项来覆盖提供商的默认设置，包括 baseUrl、customHeader、模型配置等。

**配置示例**：

```json
{
    "gcmp.providerOverrides": {
        "dashscope": {
            "models": [
                {
                    "id": "deepseek-v3.2-exp", // 增加额外模型，提示不被接受，但实际支持可用
                    "name": "Deepseek-V3.2-Exp (阿里云百炼)",
                    "tooltip": "引入了DeepSeek Sparse Attention（一种稀疏注意力机制）的实验性质版本，针对长文本的训练和推理效率进行了探索性的优化和验证。",
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
        "streamlake": [
            {
                "id": "KAT-Coder-Pro-V1",
                "model": "your-kat-coder-pro-endpoint-id"
            },
            {
                "id": "KAT-Coder-Air-V1",
                "model": "your-kat-coder-air-endpoint-id"
            },
            {
                "id": "DeepSeek-V3.2-Exp", // 部分提供商提供第三方开源模型，如有需要可自行添加
                "model": "your-deepseek-v3.2-exp-endpoint-id",
                "name": "DeepSeek-V3.2-Exp (快手万擎)",
                "tooltip": "DeepSeek-V3.2-Exp 在 V3.1-Terminus 的基础上引入了 DeepSeek Sparse Attention（一种稀疏注意力机制），针对长文本的训练和推理效率进行了探索性的优化和验证。支持深度思考。",
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
```

#### 🔌 OpenAI / Anthropic Compatible 自定义模型支持

GCMP 提供 **OpenAI / Anthropic Compatible** Provider，用于支持任何 OpenAI 或 Anthropic 兼容的 API。通过 `gcmp.compatibleModels` 配置，您可以完全自定义模型参数，包括扩展请求参数。

1. 通过 `GCMP: Compatible Provider 设置` 命令启动配置向导。
2. 在 `settings.json` 设置中编辑 `gcmp.compatibleModels` 配置项：
    - `customHeader` 及 `extraBody` 配置只可通过编辑全局 `settings.json` 配置。

```json
{
    "gcmp.compatibleModels": [
        {
            "id": "glm-4.6:openai",
            "name": "GLM-4.6 (OAI)",
            // "id": "glm-4.6:claude",
            // "name": "GLM-4.6 (Claude)",
            "provider": "zhipu",
            "sdkMode": "openai",
            "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
            // "sdkMode": "anthropic",
            // "baseUrl": "https://open.bigmodel.cn/api/anthropic",
            "model": "glm-4.6",
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
            },
            "customHeader": {
                "X-Model-Specific": "value",
                "X-Custom-Key": "${APIKEY}"
            },
            "extraBody": {
                "temperature": 0.1,
                "top_p": 0.9,
                "thinking": { "type": "disabled" }
            }
        }
    ]
}
```

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

## 🙏 致谢

感谢以下组织对本项目的支持：

- 项目Logo 来源于 [三花AI](https://sanhua.himrr.com/)，版权归 重庆毛茸茸科技有限责任公司 所有。

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。
