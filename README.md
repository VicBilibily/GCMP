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

> - [**订阅套餐**](https://bigmodel.cn/claude-code)：2个项目以内Lite套餐够用，1个项目使用基本不会超限。若需要使用截图识别图片，可直接订阅Pro套餐。
> - **搜索功能**：集成官方 Web Search API，支持实时联网搜索，仅Pro+套餐支持通过 MCP SSE 模式调用。

- **GLM-4.5**：最强推理模型，3550亿参数
- **GLM-4.5-Air**：高性价比轻量级模型
- **GLM-4.5V**：旗舰视觉推理模型，106B参数（支持图像理解）

### 💫 心流AI - iFlow

阿里巴巴旗下的的AI平台，当前[API调用](https://platform.iflow.cn/docs/)服务**免费使用**，目前[限流规则](https://platform.iflow.cn/docs/limitSpeed)为每个用户最多只能**同时发起一个**请求。

> - 心流AI的模型列表会根据官方[模型列表API](https://platform.iflow.cn/models)定时更新。
> - 目前已屏蔽不兼容 OpenAI API 消息规则的 `DeepSeek-R1` 模型。

### 🔥 DeepSeek - 深度求索

深度求索旗下的高性能推理模型，支持强大的代码生成和复杂推理任务。

- **DeepSeek V3.1 Terminus**：全面升级的对话和推理能力，支持工具调用
- **DeepSeek V3.1 Terminus (思考模式)**：基于V3.1架构的思维链推理能力，专注于复杂推理

## 🔍 智谱AI联网搜索工具

GCMP 集成了智谱AI官方的联网搜索 MCP 及 Web Search API，为AI助手提供实时联网搜索能力。

### 🚀 MCP SSE 模式（默认启用）

- **默认启用**：新版本默认使用 MCP SSE 模式
- **仅Pro+套餐支持**：非Pro+订阅套餐需将 `gcmp.zhipu.search.enableMCP` 设为 `false`

### 💰 标准计费模式

适用于非订阅套餐或需要使用高级引擎的用户：

#### 引擎支持

- **search_std** 基础版(¥0.01/次)
- **search_pro** 高级版(¥0.03/次)
- **search_pro_sogou** 搜狗(¥0.05/次)
- **search_pro_quark** 夸克(¥0.05/次)

### 使用方法

1. **设置 智谱AI API 密钥**：运行命令 `GCMP: 设置 智谱AI API密钥`
2. **模式设置**：MCP SSE 模式默认启用，可在 VS Code 设置中将 `gcmp.zhipu.search.enableMCP` 设为 `false` 切换至标准计费模式
3. **在 AI 对话中使用**：在 GitHub Copilot Chat 中直接请求搜索最新信息，模型会自动调用搜索工具
4. **手动引用**：在提示中使用 `#zhipuWebSearch` 来明确引用搜索工具

> 💡 **提示**：MCP SSE 模式默认启用，仅Pro+套餐支持。非订阅套餐请关闭此开关使用标准计费模式。如需使用高级搜索引擎，可切换至标准计费模式。

## ⚙️ 高级配置

GCMP 支持通过 VS Code 设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

### 配置AI模型参数

在 VS Code 设置中搜索 `"gcmp"` 或直接编辑 `settings.json`：

```json
{
    "gcmp.temperature": 0.1,
    "gcmp.topP": 1.0,
    "gcmp.maxTokens": 8192
}
```

### 参数说明

| 参数                    | 类型   | 默认值 | 范围/选项                 | 说明                                                                  |
| ----------------------- | ------ | ------ | ------------------------- | --------------------------------------------------------------------- |
| `gcmp.temperature`      | number | 0.1    | 0.0-2.0                   | **输出随机性**：较低值产生更确定性输出，较高值产生更有创意的输出      |
| `gcmp.topP`             | number | 1.0    | 0.0-1.0                   | **输出多样性**：使用较小值会减少输出随机性，提高一致性                |
| `gcmp.maxTokens`        | number | 8192   | 32-32768                  | **最大输出长度**：控制AI单次响应的最大token数量                       |

> 📝 **提示**：所有参数修改会立即生效。

## 🔑 获取API密钥

### 官方平台链接

| 供应商   | 官方平台                                   | 特色                                               |
| -------- | ------------------------------------------ | -------------------------------------------------- |
| 智谱AI   | [开放平台](https://open.bigmodel.cn/)      | 强大的中文理解能力，支持多模态，集成高性能搜索工具 |
| 心流AI   | [开放平台](https://platform.iflow.cn/)     | 智能动态模型更新，免费前沿模型，自动屏蔽不稳定模型 |
| DeepSeek | [开放平台](https://platform.deepseek.com/) | 强大的推理能力，支持思维链技术，专业代码生成       |

## 🚫 未列入支持的模型供应商说明

- **MoonshotAI** 目前不适合与 GitHub Copilot 集成，缓存命中率较低，Agent调用成本较高。
- **魔搭社区（ModelScope）** 仅适用于测试环境，每模型500RPD，偶尔服务不太稳定。
- **各大云厂商（阿里云、腾讯云、百度云等）** 调用按量计费不适合长期使用。

> 目前优先支持有月套餐的服务商。

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
