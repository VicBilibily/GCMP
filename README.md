# GCMP - 提供多个国内主流AI大模型供应商支持的扩展

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![Version](https://img.shields.io/visual-studio-marketplace/v/vicanent.gcmp?color=blue&label=Version)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/vicanent.gcmp?color=yellow&label=Installs)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/vicanent.gcmp?color=green&label=Downloads)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![License](https://img.shields.io/github/license/VicBilibily/GCMP?color=orange&label=License)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内的AI模型，为开发者提供更丰富、更适合的AI编程助手选择。目前支持智谱AI、Kimi、心流AI、MoonshotAI、DeepSeek、火山方舟、快手万擎、阿里云百炼、MiniMax等多家主流AI供应商，并提供 `OpenAI / Anthropic Compatible` 自定义模型支持。

## 🚀 快速开始

### 1. 安装扩展

在VS Code扩展市场搜索 `GCMP` 并安装，或使用扩展标识符：`vicanent.gcmp`

### 2. 开始使用

1. 打开 `VS Code` 的 `GitHub Copilot Chat` 面板
2. 在模型选择器中选择您想要使用的 `AI模型`
3. 开始与 `AI助手` 对话，享受强大的编程辅助功能

## 🤖 支持的AI供应商

### 🧠 [**智谱AI**](https://bigmodel.cn/) - GLM-4.5系列

> - [**订阅套餐**](https://bigmodel.cn/claude-code)：推荐订阅Pro套餐。
> - **搜索功能**：集成官方 Web Search API，支持实时联网搜索，仅Pro及以上套餐支持通过 MCP 模式调用。

- 编程套餐：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5V**
- 标准计费：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5-X**、**GLM-4.5-AirX**、**GLM-4.5V**
- 免费版本：**GLM-4.5-Flash**

### 🌙 [**Kimi**](https://www.kimi.com/) - Kimi For Coding

Kimi 登月计划 套餐的附带的 `Kimi For Coding`，当前使用 Anthropic SDK 模拟为 Roo Code 请求。

### 💫 [**心流AI**](https://platform.iflow.cn/) - iFlow

阿里巴巴旗下的的AI平台，当前[API调用](https://platform.iflow.cn/docs/)服务**免费使用**，目前[限流规则](https://platform.iflow.cn/docs/limitSpeed)为每个用户最多只能**同时发起一个**请求。

- **DeepSeek系列**：**DeepSeek-V3.2-Exp**、**DeepSeek-V3.1-Terminus**、**DeepSeek-V3-671B**
- **Qwen3系列**：**Qwen3-Coder-Plus**、**Qwen3-Coder-480B-A35B**、**Qwen3-Max**、**Qwen3-VL-Plus**、**Qwen3-Max-Preview**、**Qwen3-32B**、**Qwen3-235B-A22B**、**Qwen3-235B-A22B-Instruct**、**Qwen3-235B-A22B-Thinking**
- **Kimi系列**：**Kimi-K2-Instruct-0905**、**Kimi-K2**
- **智谱AI系列**：**GLM-4.6**

### 🌙 [**MoonshotAI**](https://platform.moonshot.cn/) - Kimi K2系列

- 支持模型：**Kimi-K2-0905-Preview**、**Kimi-K2-Turbo-Preview**、**Kimi-K2-0711-Preview**、**Kimi-Latest**

### 🔥 [**DeepSeek**](https://platform.deepseek.com/) - 深度求索

- 支持模型：**DeepSeek-V3.2-Exp**，包含思考模式聊天模型。

### 🏔️ [**火山方舟**](https://www.volcengine.com/product/ark) - 豆包大模型

- **豆包系列**：**Doubao-Seed-1.6**、**Doubao-Seed-1.6-Lite**、**Doubao-Seed-1.6-Flash**、**Doubao-Seed-1.6-Thinking**、**Doubao-Seed-1.6-Vision**
- **DeepSeek系列**：**DeepSeek-V3-250324**、**DeepSeek-V3.1-250821**、**DeepSeek-V3.1-Terminus**
- **Kimi系列**：**Kimi-K2-250905**

### 🎬 [**快手万擎**](https://streamlake.com/product/kat-coder) - StreamLake KAT-Coder

- **KAT-Coder系列**：**KAT-Coder-Pro-V1**、**KAT-Coder-Exp-72B-1010**、**KAT-Coder-Air-V1**
- **DeepSeek系列**：**DeepSeek-V3.2-Exp**、**DeepSeek-V3.1**、**DeepSeek-V3**
- **Kimi系列**：**Kimi-K2-Instruct**
- **Qwen系列**：**Qwen3-VL-235B-A22B-Instruct**、**Qwen3-VL-235B-A22B-Thinking**、**Qwen3-32B**、**Qwen3-30B-A3B**、**Qwen3-8B**、**Qwen2.5-7B-Instruct**

> 快手万擎 (KAT) StreamLake 需要手动创建 [`在线推理服务`](https://www.streamlake.com/document/WANQING/mdsosw46egl9m9lfbg) 后，在模型选择的快手万擎供应商设置中配置在线推理预置模型服务推理点ID方可使用。

### 🏭 [**阿里云百炼**](https://bailian.console.aliyun.com/) - 一站式AI开发平台

- **通义千问系列**：**Qwen-Flash**、**Qwen-Plus**、**Qwen-Max**、**Qwen3-VL-Plus**、**Qwen3-VL-Flash**、**Qwen3-Next**、**Qwen3**（开源系列多种参数规模）
- **DeepSeek系列**：**DeepSeek-V3**、**DeepSeek-V3.1**、**DeepSeek-V3.2-Exp**
- **智谱系列**：**GLM-4.5**、**GLM-4.5-Air**

### 🎨 [**MiniMax**](https://platform.minimaxi.com/login)

- **支持模型**：**MiniMax-M2**、**MiniMax-M1**、**MiniMax-Text-01**

## 🔍 智谱AI联网搜索工具

GCMP 集成了智谱AI官方的联网搜索 MCP 及 Web Search API，为AI助手提供实时联网搜索能力。

### 🚀 MCP 模式（默认启用）

- **默认启用**：默认使用 MCP 模式
- **Pro及以上套餐支持**：其他情况需将 `gcmp.zhipu.search.enableMCP` 设为 `false`

### 💰 标准计费模式

适用于非订阅套餐或需要使用高级引擎的用户：[搜索引擎说明](https://docs.bigmodel.cn/cn/guide/tools/web-search#搜索引擎说明)

### 使用方法

1. **设置 智谱AI API 密钥**：运行命令 `GCMP: 设置 智谱AI API密钥`
2. **模式设置**：MCP 模式默认启用（仅Pro及以上套餐支持），可在 VS Code 设置中将 `gcmp.zhipu.search.enableMCP` 设为 `false` 切换至标准计费模式。
3. **在 AI 对话中使用**：在 GitHub Copilot Chat 中直接请求搜索最新信息，模型会自动调用搜索工具
4. **手动引用**：在提示中使用 `#zhipuWebSearch` 来明确引用搜索工具

> 💡 **提示**：MCP 模式默认启用，仅Pro及以上套餐支持。非订阅套餐请关闭此开关使用标准计费模式。如需使用高级搜索引擎，可切换至标准计费模式。

## 仅供测试体验的供应商

> 由于各供应商 OpenAI 的兼容性问题，部分情况下可能会报错或卡住不动，建议先查看本地输出的日志后提交 Issue 进一步处理。

[**ModelScope**](https://www.modelscope.cn/)、
[**百度智能云**](https://cloud.baidu.com/)、
[**百灵大模型**](https://ling.tbox.cn/open)

> 以下供应商已结束支持，将于 `2025年11月11日` 移除，如需使用可通过自定义模型方式接入：

[**AI Ping**](https://aiping.cn/user/user-center)、
[**硅基流动**](https://siliconflow.cn/)、
[**无问芯穹**](https://cloud.infini-ai.com/)、
[**基石智算**](https://www.coreshub.cn/)、
[**腾讯云**](https://cloud.tencent.com/)、
[**华为云**](https://www.huaweicloud.com/product/modelarts/studio.html)、
[**京东云**](https://www.jdcloud.com/)、
[**七牛云**](https://www.qiniu.com/)、
[**零克云**](https://gpulink.cc/model-market/model-center/modelCenter)、
[**UCloud**](https://www.ucloud.cn/)、
[**SophNet**](https://sophnet.com/)、
[**并行智算云**](https://ai.paratera.com/)、
[**PPIO派欧云**](https://ppio.com/)、
[**蓝耘元生代**](https://maas.lanyun.net/)

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
    "gcmp.zhipu.search.enableMCP": true,
    "gcmp.editToolMode": "claude"
}
```

### 参数说明

#### 通用AI模型参数

| 参数                | 类型   | 默认值 | 范围/选项         | 说明         |
| ------------------- | ------ | ------ | ----------------- | ------------ |
| `gcmp.temperature`  | number | 0.1    | 0.0-2.0           | 输出随机性   |
| `gcmp.topP`         | number | 1.0    | 0.0-1.0           | 输出多样性   |
| `gcmp.maxTokens`    | number | 8192   | 32-32768          | 最大输出长度 |
| `gcmp.editToolMode` | string | claude | claude/gpt-5/none | 编辑工具模式 |

#### 智谱AI专用配置

| 参数                          | 类型    | 默认值 | 说明                                                                         |
| ----------------------------- | ------- | ------ | ---------------------------------------------------------------------------- |
| `gcmp.zhipu.search.enableMCP` | boolean | true   | **搜索模式**：启用MCP通讯模式（仅Pro及以上套餐支持），关闭则使用标准计费接口 |

#### 供应商配置覆盖

GCMP 支持通过 `gcmp.providerOverrides` 配置项来覆盖供应商的默认设置。

**配置示例**：

```json
{
    "gcmp.providerOverrides": {
        "zhipu": {
            "baseUrl": "https://api.z.ai/api/paas/v4",
            "models": [
                {
                    "id": "glm-4.6",
                    "model": "glm-4.6",
                    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
                    "maxInputTokens": 200000,
                    "maxOutputTokens": 64000,
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
            }
        ]
    }
}
```

#### 🔌 OpenAI / Anthropic Compatible 自定义模型支持

GCMP 提供 **OpenAI / Anthropic Compatible** Provider，用于支持任何 OpenAI 或 Anthropic 兼容的 API。通过 `gcmp.compatibleModels` 配置，您可以完全自定义模型参数。

##### 支持的 SDK 模式

- **OpenAI SDK 兼容**：支持 OpenAI API 标准格式
- **Anthropic SDK 兼容**：支持 Anthropic Messages API 格式

##### 配置自定义模型

在 VS Code 设置中编辑 `gcmp.compatibleModels` 配置项（或通过 `GCMP: Compatible Provider 设置` 命令）：

```json
{
    "gcmp.compatibleModels": [
        {
            "id": "glm-4.6:openai",
            "name": "GLM-4.6 (OAI)",
            "provider": "zhipu",
            "sdkMode": "openai",
            "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
            "model": "glm-4.6",
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
            }
        },
        {
            "id": "glm-4.6:claude",
            "name": "GLM-4.6 (Claude)",
            "provider": "zhipu",
            "sdkMode": "anthropic",
            "baseUrl": "https://open.bigmodel.cn/api/anthropic",
            "model": "glm-4.6",
            "maxInputTokens": 128000,
            "maxOutputTokens": 4096,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
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

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。
