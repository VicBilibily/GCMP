# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的所有重要更改。

## [0.9.5] - 2025-11-07

### 新增

- **MoonshotAI** 提供商新增 `Kimi-K2-Thinking` 和 `Kimi-K2-Thinking-Turbo` 思考模型
    - 已根据官方推荐固定采用 ```{ "temperature": 1.0, "top_p": 1 }```

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

## [0.6.12] - 2025-10-17

### 新增

- 新增 零克云 (gpulink) 提供商体验支持
- 新增 百灵大模型 (tbox) 提供商体验支持

## [0.6.11] - 2025-10-16

### 更新

- 更新 火山方舟 豆包1.6-20251015版本模型

## [0.6.10] - 2025-10-15

### 更新

- 更新多个提供商模型配置

## [0.6.9] - 2025-10-13

### 新增

- 新增 AI Ping (Alpha) 模型路由平台

## [0.6.8] - 2025-10-11

### 优化

- 优化插件初始化启动性能

## [0.6.7] - 2025-10-11

### 新增

- 心流AI (iFlow) 同步新增 GLM-4.6 模型

## [0.6.6] - 2025-10-10

### 修改

- 智谱AI搜索移除SSE兼容模式，修改为采用 MCP SDK 客户端连接

### 更新

- 更新 @types/vscode@1.105.0

## [0.6.5] - 2025-10-08

### 打包

- 打包包含 o200k_base.tiktoken

## [0.6.4] - 2025-10-07

### 修复

- 修正 modelscope.json 的配置

## [0.6.3] - 2025-10-07

### 修改

- ModelScope 使用独立的 SSE 流处理实现，不使用 OpenAI SDK

## [0.6.2] - 2025-10-07

### 移除

- 移除 ModelScope 的支持

## [0.6.1] - 2025-10-07

### 回滚

- 回滚 openai sdk 到 5.23.2

## [0.6.0] - 2025-10-07

### 新增

- 支持国内大型云厂商
- 新增 ModelScope 提供商并进行初步适配
- 新增 硅基流动 提供商
- 新增 阿里云百炼 提供商
- 新增 无问芯穹 提供商
- 新增 PPIO派欧云 提供商
- 新增 百度智能云 提供商
- 新增 SophNet 提供商
- 新增 七牛云 提供商
- 新增 蓝耘元生代 提供商
- 新增 并行智算云 提供商
- 新增 基石智算 提供商
- 新增 火山方舟 支持
- 增加 UCloud 提供商 动态获取模型列表
- 新增 京东云 提供商支持
- 增加 腾讯云 DeepSeek 提供商
- 新增 华为云 提供商

### 重构

- 模型配置从 packages.json 中拆分出各自独立配置

## [0.5.11] - 2025-09-30

### 更新

- 同步更新 智谱AI GLM-4.6 编程模型

## [0.5.10] - 2025-09-30

### 更新

- 更新 DeepSeek 模型
- 同步完善智谱模型

## [0.5.9] - 2025-09-29

### 优化

- iFlow 心流AI 确保同时只允许一个请求在执行，新请求进入时自动中断之前未完成的请求

## [0.5.8] - 2025-09-29

### 新增

- editToolMode 补充 grok-code，实验性设置，根据配置使用ReplaceString或EditFile

## [0.5.7] - 2025-09-29

### 新增

- 添加编辑工具模式设置，支持 Claude/GPT-5/None 三种编辑工具选择

## [0.5.6] - 2025-09-29

### 新增

- 思维模型输出思维链

## [0.5.5] - 2025-09-28

### 调整

- 调整模型家族为gpt以支持使用diff/patch格式修改文件

## [0.5.4] - 2025-09-26

### 恢复

- 恢复 MoonshotAI 的 Kimi 系列模型

## [0.5.3] - 2025-09-25

### 尝试

- 尝试接入取消请求操作

## [0.5.2] - 2025-09-23

### 增加

- 增加智谱AI联网搜索MCP服务权限检查并提示回退标准计费模式

## [0.5.1] - 2025-09-23

### 移除

- 移除 contextReduction 设置

### 调整

- 调整智谱AI联网搜索功能描述

## [0.5.0] - 2025-09-23

### 新增

- 完整支持智谱AI订阅模式
- 重新恢复支持 DeepSeek

### 修改

- 智谱搜索订阅MCP SSE模式调用
- 基本使用 OpenAI SDK 作为请求处理
- 使用 @microsoft/tiktokenizer 计算请求 token 数

---

## 早期版本 (0.1.0 - 0.4.0)

### 已实现的主要功能

- **多提供商支持**：智谱AI、心流AI、MoonshotAI、DeepSeek 等模型提供商接入
- **联网搜索**：智谱AI网络搜索工具集成
- **动态模型列表**：心流AI动态加载模型列表支持
- **编辑工具优化**：支持 Claude 风格的高效编辑替换工具
- **请求参数配置**：temperature、topP、maxTokens 等参数可配置
- **OpenAI SDK 集成**：统一使用 OpenAI SDK 处理模型请求
- **插件激活优化**：完善激活事件和命令注册机制

### 初始版本

- **0.1.0** (2025-09-11) - 项目初始化，基础架构搭建
