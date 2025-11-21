# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的所有重要更改。

## [0.12.3] - 2025-11-21

### 新增

- **MiniMax** 提供商新增 `网络搜索`(`#minimaxWebSearch`) 支持

## [0.12.2] - 2025-11-21

### 新增

- **智谱AI** 提供商新增 `GLM-4.6-Thinking` 模型模式（模型自动判断是否思考）

## [0.12.1] - 2025-11-17

- 无功能修改，仅调整提供商前缀图标

## [0.12.0] - 2025-11-17

### 新增

- **上次对话模型记忆功能** - 新增 `gcmp.rememberLastModel` 配置选项
    - 记录上次使用的模型，重启 VS Code 后自动恢复选择为当前插件提供商的模型
    - 默认启用，可在设置中禁用。禁用后保持默认行为，可能会自动选择一个 `GitHub Copilot Chat` 认为最佳的默认模型[eg：Claude Sonnet 4.5]。
- **模型信息缓存系统** - 增加模型缓存以提升初始化速度
    - 使用 VS Code globalState 持久化存储模型列表
    - 支持版本检查、API 密钥哈希校验、24小时过期机制

### 调整

- **百灵大模型** 提供商改用 Anthropic SDK 进行通讯，并从 Beta 转为常规支持提供商。

## [0.11.1] - 2025-11-15

### 调整

- **MiniMax** 提供商不再根据已设置的API密钥进行模型过滤，默认存在任意API密钥时全部模型都可供选择。

## [0.11.0] - 2025-11-15

### 新增

- **MiniMax** 提供商新增 `Coding Plan 编程套餐` 支持
    - 支持单独为 `Coding Plan 编程套餐` 设置专用 Api 密钥
- **百度智能云** 提供商新增 `ERNIE-5.0` 模型支持

## [0.10.1] - 2025-11-11

### 新增

- **火山方舟** 提供商新增 `Doubao-Seed-Code` 模型支持，支持 `Coding Plan 套餐` 模型

### 移除

- 存在自主模型的提供商移除所有的三方模型，仅保留自主模型。若要需要可自行增加使用。

## [0.10.0] - 2025-11-10

### 新增

- **MiniMax** 提供商新增 `MiniMax-M2-Stable` 模型支持

### 移除

- 移除 EOL 提供商：
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

## [0.9.6] - 2025-11-07

### 新增

- **Anthropic 兼容模式** 支持 `extraBody` 扩展请求参数配置
    - 支持将请求内容覆盖设置 `{ "top_p": null }` 以消解部分服务提供商不支持同时设置 `temperature` 和 `top_p` 的问题

## [0.9.5] - 2025-11-07

### 新增

- **MoonshotAI** 提供商新增 `Kimi-K2-Thinking` 和 `Kimi-K2-Thinking-Turbo` 思考模型
    - 已根据官方推荐固定采用 `{ "temperature": 1.0, "top_p": 1 }`

## [0.9.4] - 2025-11-04

### 调整

- [**AI Ping**](https://aiping.cn/#?invitation_code=EBQQKW) 恢复为用于测试并持续提供维护

## [0.9.3] - 2025-11-02

### 新增

- **OpenAI 兼容模式** 支持 `extraBody` 扩展请求参数配置
- **自定义 Header** 支持为所有模型配置添加 `customHeader` 自定义请求头
- **配置增强** 为 `gcmp.providerOverrides` 提供完整的编辑 schema 输入提示
- **智谱AI** 提供商新增交互式配置向导
    - ⚙️ 支持修改 API Key 和配置是否启用 MCP 搜索模式

### 优化

- **编辑工具** Claude 编辑工具模式现在指向 `claude-sonnet-4.5` 模型家族
- **ModelScope**、**Compatible** 支持 429 自动重试处理，减少 Agent 操作过早中断的情况

## [0.9.2] - 2025-11-01

### 新增

- **快手万擎** 提供商新增交互式配置向导
    - ⚙️ 支持修改 API Key 和配置模型推理点ID
    - 📝 提供模型列表及推理点ID配置状态快速查看
    - 🔄 配置完毕后返回模型列表，支持连续配置多个模型

### 优化

- **快手万擎**：选择模型并开启对话请求后，若未设置推理点ID，则提示设置推理点ID后继续

### 调整

- **模型变更**：采用通知机制让模型陪着刷新而不是重新初始化模型提供方造成整个服务重置
- **配置系统**：移除 Grok 实验性编辑工具模式配置选项

## [0.9.1] - 2025-10-30

### 维护

- 🔧 维护和更新提供商模型列表，确保模型信息准确性和时效性

### 更新

- **ModelScope** 提供商新增 `MiniMax-M2` 模型支持，并为 MiniMax 系列模型配置 Anthropic SDK 模式
- **快手万擎** 提供商新增 `Qwen3-VL-235B-A22B-Instruct` 和 `Qwen3-VL-235B-A22B-Thinking` 视觉理解模型
- **百度智能云** 提供商移除 Qwen3 系列小参数量模型（30B、32B、14B、8B、4B、1.7B、0.6B 等）
- **心流AI** 提供商移除已下线的 `GLM-4.5` 模型，保留可使用的 `GLM-4.6` 版本
- **ModelScope** 提供商状态从 Alpha 转换为 Beta 状态

## [0.9.0] - 2025-10-29

### 新增

- 🔌 新增 **OpenAI / Anthropic Compatible** Provider 支持
    - 用户可通过 `gcmp.compatibleModels` 配置完全自定义任何 OpenAI 或 Anthropic 兼容的 API
    - 在模型选择器中显示为 "OpenAI / Anthropic Compatible (Beta)"，可通过 ⚙ 设置进入配置引导

- 🎨 **MiniMax** 正式列为常规支持提供商

### 生命周期变更 (EOL)

以下提供商停止内置支持，将于 **2025年11月11日** 正式移除，你可通过自定义兼容模型继续使用这些服务：

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

## [0.8.2] - 2025-10-28

### 修复

- 修复部分模型返回错误 choice index 导致 OpenAI SDK 解析失败的问题
- 优化 OpenAI 处理器对流式响应中 choice 结构的处理逻辑

### 更新

- 升级 `@modelcontextprotocol/sdk` 依赖至 v1.20.2
- 升级 `openai` 依赖至 v6.7.0

## [0.8.1] - 2025-10-27

### 修复

- 修复 Anthropic SDK 调用结束后的 `inputTokens`、`totalTokens` 的统计输出

### 变更

- ModelScope 提供商的 `DeepSeek`、`ZhipuAI` 系列模型 现在通过 Anthropic SDK 调用

## [0.8.0] - 2025-10-27

### 新增

- 新增 `@anthropic-ai/sdk` 依赖（v0.67.0）

### 重大变更

- 智谱AI 订阅套餐语言模型（`GLM-4.6`、`GLM-4.5`、`GLM-4.5-Air`） 现在通过 Anthropic SDK 调用
- MiniMax 提供商的 `MiniMax-M2` 现在通过 Anthropic SDK 调用
- Kimi 提供商胡 `Kimi For Coding` 现在通过 Anthropic SDK 调用

## [0.7.3] - 2025-10-27

### 新增

- MiniMax 新增 `MiniMax-M2` 模型支持

## [0.7.2] - 2025-10-25

### 新增

- 新增 `Kimi会员计划` 的 `Kimi For Coding` 支持

## [0.7.1] - 2025-10-24

### 新增

- 阿里云百炼 新增 `通义千问3-VL-Flash`、`Qwen3-VL-32B` 系列模型
- 硅基流动 新增 `Qwen3-VL-32B` 系列模型

## [0.7.0] - 2025-10-24

### 新增

- 新增 快手万擎 (StreamLake) 提供商支持，可使用 `KAT-Coder` 系列模型
- 新增配置覆盖策略，允许覆盖提供商的baseUrl和模型基本配置

---

## 早期版本

早期版本实现了扩展的核心功能和基础架构，包括：

- **多提供商支持**：智谱AI、心流AI、MoonshotAI、DeepSeek 等模型提供商接入
- **国内云厂商支持**：阿里云百炼、火山方舟、百度智能云、ModelScope 等多家云厂商集成
- **联网搜索**：智谱AI网络搜索工具集成，支持 MCP SDK 客户端连接
- **编辑工具优化**：支持多种编辑工具模式（Claude/GPT-5/Grok）
- **思维链输出**：思维模型支持输出推理过程
- **配置系统**：支持 temperature、topP、maxTokens 等参数配置
- **OpenAI SDK 集成**：统一使用 OpenAI SDK 处理模型请求
- **Token 计算**：集成 @microsoft/tiktokenizer 进行 token 计算
