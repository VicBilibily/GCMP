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

### 🌙 MoonshotAI - Kimi K2系列

- **Kimi-K2-0905-Preview**：更强 Agentic Coding 能力，优化前端代码美观度（256K上下文）
- **Kimi-K2-Turbo-Preview**：高速版本模型，60-100 tokens/秒输出速度（256K上下文）
- **Kimi-K2-0711-Preview**：K2系列基础版本（128K上下文）

### 💫 iFlow - 心流AI

- **Qwen3-Coder-480B-A35B**：专业代码生成和推理模型（256K上下文）
- **Kimi-K2-Instruct-0905**：月之暗面万亿参数MoE模型，320亿激活参数
- **GLM-4.5**：智谱AI多模态模型，支持图像理解（128K上下文）

## 🔍 智谱AI搜索工具

GCMP 集成了智谱AI官方的 Web Search API，为AI助手提供实时联网搜索能力。

### 工具特性

- ✅ **多引擎支持**：基础版(¥0.01/次)、高级版(¥0.03/次)、搜狗(¥0.05/次)、夸克(¥0.05/次)
- 🎯 **精确控制**：支持域名过滤、时间范围、结果数量等参数
- 📊 **结构化结果**：提供标题、摘要、链接、发布时间等完整信息

### 使用方法

1. **设置 API 密钥**：运行命令 `GCMP: 设置 智谱AI API密钥`
2. **在 AI 对话中使用**：在 GitHub Copilot Chat 中直接请求搜索最新信息，模型会自动调用搜索工具
3. **手动引用**：在提示中使用 `#zhipuWebSearch` 来明确引用搜索工具

## ⚙️ 高级配置

GCMP支持通过VS Code设置来自定义AI模型的行为参数，让您获得更个性化的AI助手体验。

### 配置AI模型参数

在 VS Code 设置中搜索 `"gcmp"` 或直接编辑 `settings.json`：

```json
{
  "gcmp.temperature": 0.1,
  "gcmp.topP": 1.0,  
  "gcmp.maxTokens": 8192,
  "gcmp.contextReduction": "1x"
}
```

### 参数说明

| 参数                        | 类型    | 默认值  | 范围/选项                 | 说明                                                                 |
| --------------------------- | ------- | ------- | ------------------------- | -------------------------------------------------------------------- |
| `gcmp.temperature`          | number  | 0.1     | 0.0-2.0                   | **输出随机性**：较低值产生更确定性输出，较高值产生更有创意的输出     |
| `gcmp.topP`                 | number  | 1.0     | 0.0-1.0                   | **输出多样性**：使用较小值会减少输出随机性，提高一致性               |
| `gcmp.maxTokens`            | number  | 8192    | 32-32768                  | **最大输出长度**：控制AI单次响应的最大token数量                      |
| `gcmp.contextReduction`     | string  | "1x"    | "1x", "1/2", "1/4", "1/8" | **上下文缩减**：控制模型可接受的输入上下文长度，缩减可提升响应速度 ⚠️ |

> ⚠️ **重要提示**：`gcmp.contextReduction` 参数修改后需要重启 VS Code 才能生效。其他参数修改会立即生效。

### 上下文缩减级别说明

| 级别  | 效果                    | 适用场景                 | 特点               |
| ----- | ----------------------- | ------------------------ | ------------------ |
| `1x`  | 完整上下文（128K/256K） | 复杂推理任务、长文档分析 | 保持完整理解能力   |
| `1/2` | 缩减至1/2（64K/128K）   | 平衡理解能力与处理效率   | 适合大多数使用场景 |
| `1/4` | 缩减至1/4（32K/64K）    | 一般对话、代码片段分析   | 专注于近期对话内容 |
| `1/8` | 缩减至1/8（16K/32K）    | 简单查询、快速问答       | 仅保留最关键信息   |

## 🔑 获取API密钥

### 官方平台链接

| 供应商     | 官方平台                               | 特色                           |
| ---------- | -------------------------------------- | ------------------------------ |
| 智谱AI     | [开放平台](https://open.bigmodel.cn/)  | 强大的中文理解能力，支持多模态 |
| MoonshotAI | [开放平台](https://api.moonshot.cn/)   | 超长上下文，Agentic能力        |
| 心流AI     | [开放平台](https://platform.iflow.cn/) | AI开发者平台，免费前沿模型     |

> 💡 **提示**：各平台通常提供免费额度用于测试和开发，建议先注册体验后选择最适合的模型。

## 🚫 未列入支持的模型供应商说明

- **DeepSeek** 的 API 输出格式不完全遵循 OpenAI 标准，导致与 GitHub Copilot 集成存在兼容性问题。
- **魔搭社区（ModelScope）** 仅适用于测试环境，长期使用不太稳定。
- **各大云厂商（阿里云、腾讯云、百度云等）** 按量计费不适合长期使用。
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

# 启动开发模式
npm run watch # 按下 F5 开始扩展调试

# 运行测试
npm run test
```

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。
