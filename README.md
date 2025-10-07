# GCMP - 提供多个国内主流AI大模型供应商支持的扩展

[![CI](https://github.com/VicBilibily/GCMP/actions/workflows/ci.yml/badge.svg)](https://github.com/VicBilibily/GCMP/actions)
[![Version](https://img.shields.io/visual-studio-marketplace/v/vicanent.gcmp?color=blue&label=Version)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/vicanent.gcmp?color=green&label=Downloads)](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)
[![License](https://img.shields.io/github/license/VicBilibily/GCMP?color=orange&label=License)](https://github.com/VicBilibily/GCMP/blob/main/LICENSE)

通过集成国内顶尖的AI模型，为开发者提供更丰富、更适合的AI编程助手选择。目前支持智谱AI、心流AI、MoonshotAI、DeepSeek、火山方舟、阿里云百炼等20+家主流AI供应商。

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
> - **搜索功能**：集成官方 Web Search API，支持实时联网搜索，仅Pro及以上套餐支持通过 MCP SSE 模式调用。

- 编程套餐：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5V**
- 标准计费：**GLM-4.6**、**GLM-4.5**、**GLM-4.5-Air**、**GLM-4.5-X**、**GLM-4.5-AirX**、**GLM-4.5V**
- 免费版本：**GLM-4.5-Flash**

### 💫 [**心流AI**](https://platform.iflow.cn/) - iFlow

阿里巴巴旗下的的AI平台，当前[API调用](https://platform.iflow.cn/docs/)服务**免费使用**，目前[限流规则](https://platform.iflow.cn/docs/limitSpeed)为每个用户最多只能**同时发起一个**请求。

- **支持模型**：**DeepSeek-V3.2-Exp**、**DeepSeek-V3.1-Terminus**、**DeepSeek-V3-671B**、**Qwen3-Coder-Plus**、**Qwen3-Coder-480B-A35B**、**Qwen3-Max**、**Qwen3-VL-Plus**、**Qwen3-Max-Preview**、**Qwen3-32B**、**Qwen3-235B-A22B**、**Qwen3-235B-A22B-Instruct**、**Qwen3-235B-A22B-Thinking**、**GLM-4.5**、**Kimi-K2-Instruct-0905**、**Kimi-K2**

### 🌙 [**MoonshotAI**](https://platform.moonshot.cn/) - Kimi K2系列

- 支持模型：**Kimi-K2-0905-Preview**、**Kimi-K2-Turbo-Preview**、**Kimi-K2-0711-Preview**、**Kimi-Latest**

### 🔥 [**DeepSeek**](https://platform.deepseek.com/) - 深度求索

深度求索旗下的高性能推理模型，支持强大的代码生成和复杂推理任务。

- 支持模型：**DeepSeek-V3.2-Exp**，包含思考模式聊天模型。
- 保留模型：**DeepSeek-V3.1-Terminus**，包含思考模式聊天模型。保留到北京时间 2025 年 10 月 15 日 23:59。

### 🏔️ [**火山方舟**](https://www.volcengine.com/product/ark) - 豆包大模型

- **豆包系列**：**Doubao-Seed-1.6**、**Doubao-Seed-1.6-Flash**、**Doubao-Seed-1.6-Thinking**、**Doubao-Seed-1.6-Vision**
- **DeepSeek系列**：**DeepSeek-V3**、**DeepSeek-V3.1**、**DeepSeek-V3.1-Terminus**
- **Kimi系列**：**Kimi-K2**

### 🏭 [**阿里云百炼**](https://bailian.console.aliyun.com/) - 一站式AI开发平台

- **通义千问系列**：**Qwen-Flash**、**Qwen-Plus**、**Qwen-Max**、**Qwen3-VL-Plus**、**Qwen3-Next**、**Qwen3**（多种参数规模）
- **DeepSeek系列**：**DeepSeek-V3**、**DeepSeek-V3.1**、**DeepSeek-V3.2-Exp**
- **智谱系列**：**GLM-4.5**、**GLM-4.5-Air**

## 🔍 智谱AI联网搜索工具

GCMP 集成了智谱AI官方的联网搜索 MCP 及 Web Search API，为AI助手提供实时联网搜索能力。

### 🚀 MCP SSE 模式（默认启用）

- **默认启用**：新版本默认使用 MCP SSE 模式
- **Pro及以上套餐支持**：其他情况需将 `gcmp.zhipu.search.enableMCP` 设为 `false`

### 💰 标准计费模式

适用于非订阅套餐或需要使用高级引擎的用户：[搜索引擎说明](https://docs.bigmodel.cn/cn/guide/tools/web-search#搜索引擎说明)

### 使用方法

1. **设置 智谱AI API 密钥**：运行命令 `GCMP: 设置 智谱AI API密钥`
2. **模式设置**：MCP SSE 模式默认启用（仅Pro及以上套餐支持），可在 VS Code 设置中将 `gcmp.zhipu.search.enableMCP` 设为 `false` 切换至标准计费模式。
3. **在 AI 对话中使用**：在 GitHub Copilot Chat 中直接请求搜索最新信息，模型会自动调用搜索工具
4. **手动引用**：在提示中使用 `#zhipuWebSearch` 来明确引用搜索工具

> 💡 **提示**：MCP SSE 模式默认启用，仅Pro及以上套餐支持。非订阅套餐请关闭此开关使用标准计费模式。如需使用高级搜索引擎，可切换至标准计费模式。

## 仅供测试体验的供应商

> 由于各供应商 OpenAI 的兼容性问题，部分情况下可能会报错或卡住不动，建议先查看本地输出的日志后提交 Issue 进一步处理。

[**MiniMax**](https://platform.minimaxi.com/login)、
[**硅基流动**](https://siliconflow.cn/)、
[**无问芯穹**](https://cloud.infini-ai.com/)、
[**基石智算**](https://www.coreshub.cn/)、
[**腾讯云**](https://cloud.tencent.com/)、
[**华为云**](https://www.huaweicloud.com/product/modelarts/studio.html)、
[**京东云**](https://www.jdcloud.com/)、
[**UCloud**](https://www.ucloud.cn/)、
[**七牛云**](https://www.qiniu.com/)、
[**SophNet**](https://sophnet.com/)、
[**并行智算云**](https://www.paratera.com/)、
[**PPIO派欧云**](https://ppio.com/)、
[**蓝耘元生代**](https://www.lanyunai.com/)、
[**百度智能云**](https://cloud.baidu.com/)

> 暂不适配的供应商（2025年10月）：

- **魔搭社区（ModelScope）**：魔搭社区平台OpenAI接口输出格式不兼容新版本的 `OpenAI SDK`，存在大量兼容问题，故不作适配。
- [**SenseCore (商汤大装置)**](https://console.sensecore.cn/aistudio)：经测试，所有模型的Tools工具调用返回格式不兼容。
- [**金山云星流**](https://www.ksyun.com/nv/product/KSP)：企业独立部署模式，暂不支持个人用户认证注册使用。
- [**天翼云**](https://www.ctyun.cn/products/huiju)：运营商云，都是旧版本模型，模型更新并不给力。
- [**移动云**](https://ecloud.10086.cn/portal/product/MaaS)：运营商云，都是旧版本模型，模型更新并不给力。
- [**讯飞星辰**](https://xinghuo.xfyun.cn/maas-home)：定制服务，暂不支持公有云通用服务调用。

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
