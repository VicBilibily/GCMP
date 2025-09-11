# GCMP - 提供多个国内主流AI大模型供应商支持的扩展

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![Version](https://img.shields.io/visual-studio-marketplace/v/vicanent.gcmp?color=blue&label=Version)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/vicanent.gcmp?color=green&label=Downloads)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![License](https://img.shields.io/github/license/VicBilibily/GCMP?color=orange&label=License)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内顶尖的AI模型，为开发者提供更丰富、更适合的AI编程助手选择。

## 🚀 快速开始

### 1. 安装扩展
在VS Code扩展市场搜索`GCMP`并安装，或使用扩展标识符：`vicanent.gcmp`

### 2. 配置API密钥
使用VS Code命令面板（`Ctrl+Shift+P`）执行以下命令来配置相应供应商的API密钥：

| 供应商 | 命令 | 说明 |
|--------|------|------|
| 智谱AI | `gcmp.zhipu.setApiKey` | 配置智谱AI的API密钥 |
| MoonshotAI | `gcmp.moonshot.setApiKey` | 配置月之暗面的API密钥 |
| DeepSeek | `gcmp.deepseek.setApiKey` | 配置DeepSeek的API密钥 |
| 魔搭社区 | `gcmp.modelscope.setApiKey` | 配置魔搭社区的API密钥 |
| iFlow心流 | `gcmp.iflow.setApiKey` | 配置iFlow心流的API密钥 |

### 3. 开始使用
1. 打开VS Code的GitHub Copilot Chat面板
2. 在模型选择器中选择您想要使用的AI模型
3. 开始与AI助手对话，享受强大的编程辅助功能

## ✨ 功能亮点

- 🔄 **双SDK架构**：集成 Anthropic SDK 和 OpenAI SDK
- 🚀 **流式响应**：支持实时对话流，提供流畅的交互体验
- 🔧 **工具调用**：支持函数执行和高级工具调用功能
- 👁️ **多模态支持**：部分模型支持图像理解和分析
- 🔐 **安全管理**：独立的API密钥管理，确保数据安全
- 🎯 **即插即用**：集成到 VS Code GitHub Copilot 模型选择器

## 🤖 支持的AI供应商

### 🧠 智谱AI - GLM-4.5系列

- **GLM-4.5** (订阅)：最强推理模型（使用 Anthropic SDK）
- **GLM-4.5-Air** (订阅)：高性价比轻量级模型（使用 Anthropic SDK）
- **GLM-4.5-X**：高性能强推理模型
- **GLM-4.5-AirX**：轻量级极速响应模型
- **GLM-4.5-Flash** (免费)：免费高效多功能模型
- **GLM-4.5V** (视觉)：旗舰视觉推理模型（支持图像理解）

### 🌙 MoonshotAI - Kimi K2系列

- **Kimi-K2-0905-Preview**：最强 Agentic Coding 能力（256K上下文）
- **Kimi-K2-Turbo-Preview**：高速版本（60-100 tokens/秒）
- **Kimi-K2-0711-Preview**：K2系列基础版（128K上下文）

### 🔥 DeepSeek - 深度求索

- **DeepSeek V3.1** (官方)：全面升级的对话和推理能力
- **DeepSeek V3.1** (思考模式)：基于V3.1架构的思维链推理能力

### 🌟 魔搭社区 - ModelScope

- **Qwen3-235B-A22B-Instruct-2507**：最新一代超大规模模型
- **Qwen3-30B-A3B-Instruct-2507**：高效轻量级版本
- **Qwen3-Coder-480B-A35B-Instruct**：专业代码生成模型
- **Qwen3-Coder-30B-A3B-Instruct**：轻量代码推理模型

### 💫 iFlow心流 - AI 开发者平台

- **Qwen3-Max-Preview** 🔥：通义千问3系列Max预览版
- **Qwen3-Coder-480B-A35B**：专业代码生成和推理
- **GLM-4.5**：智谱AI多模态模型
- **Kimi-K2**：月之暗面K2模型
- **Kimi-K2-Instruct-0905**：万亿参数MoE模型
- **DeepSeek-V3.1**：深度求索推理模型

## ⚙️ 高级配置

GCMP支持通过VS Code设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

### 配置AI模型参数
在VS Code设置中搜索"gcmp"或直接编辑settings.json：

```json
{
  "gcmp.temperature": 0.1,    // 控制AI输出随机性 (0.0-2.0)
  "gcmp.topP": 1.0,           // 控制AI输出多样性 (0.0-1.0)  
  "gcmp.maxTokens": 4096      // 控制AI最大输出长度 (1-32768)
}
```

### 参数说明

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|------|------|-------|------|------|
| `gcmp.temperature` | number | 0.1 | 0.0-2.0 | **输出随机性**：较低值产生更确定性输出，较高值产生更有创意的输出 |
| `gcmp.topP` | number | 1.0 | 0.0-1.0 | **输出多样性**：使用较小值会减少输出随机性，提高一致性 |
| `gcmp.maxTokens` | number | 4096 | 1-32768 | **最大输出长度**：控制AI单次响应的最大token数量 |

> 💡 **提示**：配置修改后会立即生效，无需重启VS Code。不同的模型供应商都会使用这些统一的配置参数。

## 🔑 获取API密钥

### 官方平台链接
| 供应商 | 官方平台 | 特色 |
|--------|----------|------|
| 智谱AI | [开放平台](https://open.bigmodel.cn/) | 强大的中文理解能力，支持多模态 |
| MoonshotAI | [开放平台](https://api.moonshot.cn/) | 超长上下文，Agentic能力 |
| DeepSeek | [开放平台](https://api.deepseek.com/) | 深度推理能力，思维链技术 |
| 魔搭社区 | [ModelScope](https://www.modelscope.cn/) | 开源AI模型社区平台 |
| iFlow心流 | [心流平台](https://platform.iflow.cn/) | AI开发者平台，免费前沿模型 |

> 💡 **提示**：各平台通常提供免费额度用于测试和开发，建议先注册体验后选择最适合的模型。

## 🤝 贡献指南

我们欢迎社区贡献！无论是报告bug、提出功能建议还是提交代码，都能帮助这个项目变得更好。

### 开发环境设置
```bash
# 克隆项目
git clone https://github.com/VicBilibily/GCMP.git
cd GCMP

# 安装依赖
npm install

# 启动开发模式
npm run watch # 按下 F5 开始扩展调试

# 运行测试
npm run test
```

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

---

<div align="center">

**为开发者提供更多AI模型选择** ✨

[🐛 报告问题](https://github.com/VicBilibily/GCMP/issues) · [💡 功能建议](https://github.com/VicBilibily/GCMP/issues) · [📖 文档](https://github.com/VicBilibily/GCMP/wiki)

</div>
