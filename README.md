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

- **GLM-4.5** (订阅)：最强推理模型，3550亿参数（128K上下文）
- **GLM-4.5-Air** (订阅)：高性价比轻量级模型（128K上下文）
- **GLM-4.5-X** (极速)：高性能强推理模型，极速响应
- **GLM-4.5-AirX** (极速)：轻量级高性能模型，极速响应
- **GLM-4.5-Flash** (免费)：免费高效多功能模型
- **GLM-4.5V** (视觉)：旗舰视觉推理模型，106B参数（支持图像理解）

### 🔥 DeepSeek - 深度求索

- **DeepSeek V3.1** (官方)：全面升级的对话和推理能力
- **DeepSeek V3.1** (思考模式)：基于V3.1架构的思维链推理能力

### 🌙 MoonshotAI - Kimi K2系列

- **Kimi-K2-0905-Preview**：更强 Agentic Coding 能力，优化前端代码美观度（256K上下文）
- **Kimi-K2-Turbo-Preview**：高速版本模型，60-100 tokens/秒输出速度（256K上下文）
- **Kimi-K2-0711-Preview**：K2系列基础版本（128K上下文）

### 💫 iFlow - 心流AI

- **Qwen3-Coder-480B-A35B**：专业代码生成和推理模型（256K上下文）
- **Kimi-K2-Instruct-0905**：月之暗面万亿参数MoE模型，320亿激活参数
- **GLM-4.5**：智谱AI多模态模型，支持图像理解（128K上下文）
- **DeepSeek-V3.1**：深度求索V3.1模型，强大的推理能力

## ⚙️ 高级配置

GCMP支持通过VS Code设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

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

| 参数               | 类型   | 默认值 | 范围    | 说明                                                             |
| ------------------ | ------ | ------ | ------- | ---------------------------------------------------------------- |
| `gcmp.temperature` | number | 0.1    | 0.0-2.0 | **输出随机性**：较低值产生更确定性输出，较高值产生更有创意的输出 |
| `gcmp.topP`        | number | 1.0    | 0.0-1.0 | **输出多样性**：使用较小值会减少输出随机性，提高一致性           |
| `gcmp.maxTokens`   | number | 8192   | 1-32768 | **最大输出长度**：控制AI单次响应的最大token数量                  |

> 💡 **提示**：配置修改后会立即生效，无需重启VS Code。不同的模型供应商都会使用这些统一的配置参数。

## 🔑 获取API密钥

### 官方平台链接

| 供应商     | 官方平台                               | 特色                           |
| ---------- | -------------------------------------- | ------------------------------ |
| 智谱AI     | [开放平台](https://open.bigmodel.cn/)  | 强大的中文理解能力，支持多模态 |
| DeepSeek   | [开放平台](https://api.deepseek.com/)  | 深度推理能力，思维链技术       |
| MoonshotAI | [开放平台](https://api.moonshot.cn/)   | 超长上下文，Agentic能力        |
| 心流AI     | [开放平台](https://platform.iflow.cn/) | AI开发者平台，免费前沿模型     |

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
