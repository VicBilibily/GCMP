# GCMP - 提供多个国内主流AI大模型供应商支持的扩展

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![Version](https://img.shields.io/visual-studio-marketplace/v/vicanent.gcmp?color=blue&label=Version)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/vicanent.gcmp?color=green&label=Downloads)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![License](https://img.shields.io/github/license/VicBilibily/GCMP?color=orange&label=License)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内顶尖的AI模型，为开发者提供更丰富、更适合的AI编程助手选择。

## 🚀 快速开始

### 1. 安装扩展

在VS Code扩展市场搜索 `GCMP` 并安装，或使用扩展标识符：`vicanent.gcmp`

### 2. 开始使用

1. 打开 `VS Code` 的 `GitHub Copilot Chat` 面板
2. 在模型选择器中选择您想要使用的 `AI模型`
3. 开始与 `AI助手` 对话，享受强大的编程辅助功能

## 🤖 支持的AI供应商

### 🧠 智谱AI - GLM-4.5系列

> - [**订阅套餐**](https://bigmodel.cn/claude-code)：推荐订阅Pro套餐。
> - **搜索功能**：集成官方 Web Search API，支持实时联网搜索，仅Pro及以上套餐支持通过 MCP SSE 模式调用。

- 编程套餐：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5V**
- 标准计费：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5-X**、**GLM-4.5-AirX**、**GLM-4.5V**
- 免费版本：**GLM-4.5-Flash**

### 💫 心流AI - iFlow

阿里巴巴旗下的的AI平台，当前[API调用](https://platform.iflow.cn/docs/)服务**免费使用**，目前[限流规则](https://platform.iflow.cn/docs/limitSpeed)为每个用户最多只能**同时发起一个**请求。

> - 心流AI的模型列表会根据心流[模型列表API](https://platform.iflow.cn/models)定时更新。目前已屏蔽不兼容 OpenAI API 消息规则的 `DeepSeek-R1` 模型。

### 🌙 MoonshotAI - Kimi K2系列

- 支持模型：**Kimi-K2-0905-Preview**、**Kimi-K2-Turbo-Preview**、**Kimi-K2-0711-Preview**、**Kimi-Latest**

### 🔥 DeepSeek - 深度求索

深度求索旗下的高性能推理模型，支持强大的代码生成和复杂推理任务。

- 支持模型：**DeepSeek-V3.2-Exp**，包含思考模式聊天模型。
- 保留模型：**DeepSeek-V3.1-Terminus**，包含思考模式聊天模型。保留到北京时间 2025 年 10 月 15 日 23:59。

## 🔍 智谱AI联网搜索工具

GCMP 集成了智谱AI官方的联网搜索 MCP 及 Web Search API，为AI助手提供实时联网搜索能力。

### 🚀 MCP SSE 模式（默认启用）

- **默认启用**：新版本默认使用 MCP SSE 模式
- **Pro及以上套餐支持**：其他情况需将 `gcmp.zhipu.search.enableMCP` 设为 `false`

### 💰 标准计费模式

适用于非订阅套餐或需要使用高级引擎的用户：[搜索引擎说明](https://docs.bigmodel.cn/cn/guide/tools/web-search#%E6%90%9C%E7%B4%A2%E5%BC%95%E6%93%8E%E8%AF%B4%E6%98%8E)

### 使用方法

1. **设置 智谱AI API 密钥**：运行命令 `GCMP: 设置 智谱AI API密钥`
2. **模式设置**：MCP SSE 模式默认启用（仅Pro及以上套餐支持），可在 VS Code 设置中将 `gcmp.zhipu.search.enableMCP` 设为 `false` 切换至标准计费模式。
3. **在 AI 对话中使用**：在 GitHub Copilot Chat 中直接请求搜索最新信息，模型会自动调用搜索工具
4. **手动引用**：在提示中使用 `#zhipuWebSearch` 来明确引用搜索工具

> 💡 **提示**：MCP SSE 模式默认启用，仅Pro及以上套餐支持。非订阅套餐请关闭此开关使用标准计费模式。如需使用高级搜索引擎，可切换至标准计费模式。

## 仅供测试体验的供应商

> 正在根据 [AiPing.cn](https://aiping.cn/supplierList) 进行逐一适配。由于各供应商 OpenAI SDK 的兼容性都是部分兼容，部分情况下可能会报错或卡住不动，建议先查看本地输出的日志后提交 Issue 进一步处理。

- [**MiniMax**](https://platform.minimaxi.com/login) [支持模型](https://platform.minimaxi.com/document/text_api_intro?key=68abd86ad08627aad9673eaa)

> 暂不适配的供应商：
- [**SenseCore (商汤大装置)**](https://console.sensecore.cn/aistudio)：暂无权限，需与日日新团队申请？


## ⚙️ 高级配置

GCMP 支持通过 VS Code 设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

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

| 参数                | 类型   | 默认值 | 范围/选项                   | 说明                                                             |
| ------------------- | ------ | ------ | --------------------------- | ---------------------------------------------------------------- |
| `gcmp.temperature`  | number | 0.1    | 0.0-2.0                     | **输出随机性**：较低值产生更确定性输出，较高值产生更有创意的输出 |
| `gcmp.topP`         | number | 1.0    | 0.0-1.0                     | **输出多样性**：使用较小值会减少输出随机性，提高一致性           |
| `gcmp.maxTokens`    | number | 8192   | 32-32768                    | **最大输出长度**：控制AI单次响应的最大token数量                  |
| `gcmp.editToolMode` | string | claude | claude/gpt-5/grok-code/none | **编辑工具模式**：选择AI编辑代码时使用的工具风格                 |

#### 智谱AI专用配置

| 参数                          | 类型    | 默认值 | 说明                                                                         |
| ----------------------------- | ------- | ------ | ---------------------------------------------------------------------------- |
| `gcmp.zhipu.search.enableMCP` | boolean | true   | **搜索模式**：启用SSE通讯模式（仅Pro及以上套餐支持），关闭则使用标准计费接口 |

> 📝 **提示**：所有参数修改会立即生效。

## 🔑 获取API密钥

### 官方平台链接

| 供应商     | 官方平台                                   | 特色                                               |
| ---------- | ------------------------------------------ | -------------------------------------------------- |
| 智谱AI     | [开放平台](https://open.bigmodel.cn/)      | 强大的中文理解能力，支持多模态，集成高性能搜索工具 |
| 心流AI     | [开放平台](https://platform.iflow.cn/)     | 智能动态模型更新，免费前沿模型，自动屏蔽不稳定模型 |
| MoonshotAI | [开放平台](https://api.moonshot.cn/)       | 超长上下文，Agentic能力                            |
| DeepSeek   | [开放平台](https://platform.deepseek.com/) | 强大的推理能力，支持思维链技术，专业代码生成       |

## 🚫 未列入支持的模型供应商说明

> 目前优先支持有月套餐的服务商，云服务厂商及接口输出速度低于 `30token/s` 的模型供应商暂不考虑支持。

- **魔搭社区（ModelScope）** 仅适用于测试环境，每模型500RPD，共享服务不太稳定。各个模型的OpenAI兼容模式都有各自的实现，输出格式不是平台统一，适配工作量较大，故此插件不提供此服务商。若有需要可使用官方的 `OpenAI Compatible` 模式（预计2025年10月版本正式发布支持，目前正式版可使用 [`OAI Compatible Provider for Copilot`](https://marketplace.visualstudio.com/items?itemName=johnny-zhao.oai-compatible-copilot) ）。
- **各大云厂商（阿里云、腾讯云、百度云等）** 调用按量计费不适合长期使用。


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
