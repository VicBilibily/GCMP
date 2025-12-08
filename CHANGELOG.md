# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的所有重要更改。

## [0.14.15] - 2025-12-08

- **OpenAI / Anthropic Compatible** 内置部分已知提供商支持余额查询：
  - **aiping**： [**AI Ping**](https://aiping.cn/#?invitation_code=EBQQKW) 用户账户余额(5分钟刷新)
  - **aihubmix**: [**AIHubMix**](https://aihubmix.com/?aff=xb8N) ApiKey余额
  - **siliconflow**：[**硅基流动**](https://cloud.siliconflow.cn/i/tQkcsZbJ) 用户账户余额(5分钟刷新)

## [0.14.14] - 2025-12-08

- **智谱AI** 提供商模型维护：
    - **编程套餐**：新增 **GLM-4.6V**(Thinking)
    - **按量计费**：新增 **GLM-4.6V**(默认思考)

## [0.14.13] - 2025-12-07

### 新增

- **OpenAI / Anthropic Compatible** 内置部分已知提供商ID及名称：
  - **aiping**： [**AI Ping**](https://aiping.cn/#?invitation_code=EBQQKW)
  - **aihubmix**: [**AIHubMix**](https://aihubmix.com/?aff=xb8N) 推理时代，可立享 10% 优惠。
  - **siliconflow**：[**硅基流动**](https://cloud.siliconflow.cn/i/tQkcsZbJ)


## [0.14.12] - 2025-12-07

### 调整

- 发生错误时不再自动打开输出窗口，以减少对用户的干扰。[#20](https://github.com/VicBilibily/GCMP/pull/20)

## [0.14.11] - 2025-12-05

### 新增

- **火山方舟** 提供商新增 `DeepSeek-V3.2` 模型：
    - Coding Plan 套餐：`DeepSeek-V3.2`(思考模式)
    - 协作奖励计划：`DeepSeek-V3.2-251201`(思考模式)

## [0.14.10] - 2025-12-04

### 新增

- **MiniMax** 提供商 支持国际站 Coding Plan 编程套餐接入：`MiniMax-M2`、联网搜索、用量查询。

## [0.14.9] - 2025-12-02

### 修复

- 状态栏：完善 **DeepSeek**、**MoonshotAI** 提供商密钥变更后的状态栏同步显示/隐藏。

## [0.14.8] - 2025-12-02

### 修复

- 修复状态栏用量及余额显示图标隐藏某个项目后会全部隐藏的问题，现已可单独隐藏某个提供商的状态图标。

## [0.14.7] - 2025-12-02

### 新增

- **MoonshotAI** 提供商新增余额查询支持，状态栏显示当前剩余可用余额（每 5 分钟自动刷新）。

## [0.14.6] - 2025-12-02

### 调整

- **火山方舟** 提供商新增协作奖励计划模型：`Kimi-K2-Thinking-251104`(暂不输出思考内容)
- **MoonshotAI** 提供商的思考模型调整，暂时关闭思考模型的思考内容输出。
    - 调整模型：`Kimi-K2-Thinking`、`Kimi-K2-Thinking-Turbo`

## [0.14.5] - 2025-12-01

### 调整

- **火山方舟** 提供商模型维护：
    - 新增 **协作奖励计划** 模型：`DeepSeek-V3.1-terminus`、`Kimi-K2-250905`

## [0.14.4] - 2025-12-01

### 调整

- **DeepSeek** 提供商同步更新模型 `DeepSeek-V3.2`，并兼容支持思考模式的Agent工具调用。
    - 另同步新增 `DeepSeek-V3.2-Speciale` 模型，该模型只支持思考模式，不支持工具调用，支持时间截止至北京时间 2025-12-15 23:59。
    - 新增余额查询支持，状态栏显示当前剩余可用余额（每 5 分钟自动刷新）。

## [0.14.3] - 2025-12-01

### 调整

1.  调整提供商前缀图标
2.  补充 gcmp.compatibleModels 的 provider 参数说明

## [0.14.2] - 2025-12-01

### 调整

- **ModelScope魔搭社区** 提供商模型维护：
    - 移除不再提供的智谱AI模型：`GLM-4.6`、`GLM-4.5`

### 生命周期变更 (EOL)

- **ModelScope魔搭社区**
    - 2025-12-11 移除内置支持：此提供商仅适用于测试，各模型提供的 推理 API-Inference 接口不定时关闭服务。
- **心流AI**
    - 2025-12-31 移除内置支持：官方已专注于完善 `iFlow CLI`，免费API调用已不再提供新增模型，存量模型亦在逐步下线。

## [0.14.1] - 2025-11-30

### 修复

- **OpenAI / Anthropic Compatible** 在模型选择列表正确显示模型来源 `OpenAI Compatible` 或 `Anthropic Compatible`

## [0.14.0] - 2025-11-30

### 调整

- **OpenAI / Anthropic Compatible** 自定义兼容模型提供商结束 GA 测试阶段
- **AI Ping** 提供商正式结束内置支持并移除

### 修复

- **AnthropicHandler** 修复：添加缺失的 Authorization header 以解决 MiniMax 服务兼容性问题 [#11](https://github.com/VicBilibily/GCMP/pull/11)

## [0.13.6] - 2025-11-29

### 调整

- **智谱AI** 提供商模型维护：
    - 按量计费模型明确在模型选择列表强调计费，以免错误选用非编程套餐模型造成欠费
    - 移除加价X计费模型：`GLM-4.5-X`、`GLM-4.5-AirX`
- **MiniMax** 提供商模型维护：
    - 按量计费模型明确在模型选择列表强调计费，以免错误选用非编程套餐模型造成欠费
    - 移除免费使用时期的按量计费模型：`MiniMax-M2-Stable`
- **火山方舟** 提供商模型维护：
    - 按量计费模型明确在模型选择列表强调计费，以免错误选用非编程套餐模型造成欠费

## [0.13.5] - 2025-11-28

### 调整

- **ModelScope魔搭社区** 提供商模型维护：
    - 补充模型：`通义千问3-Coder-480B-A35B-Instruct`、`通义千问3-235B-A22B`、`通义千问3-235B-A22B-Instruct-2507`、`通义千问3-Next-80B-A3B-Instruct`
    - 移除模型：`MiniMax-M2`

## [0.13.4] - 2025-11-25

### 新增

- 订阅状态自动刷新：新增用户活跃记录，30分钟无操作则暂停自动刷新用量信息。

## [0.13.3] - 2025-11-25

### 调整

- **MiniMax** 提供商的 `MiniMax-M2` 模型按照官方 `Anthropic API 兼容接口` 要求，将 `thinking` 块添加到消息历史

### 生命周期变更 (EOL)

- **AI Ping** 提供商停止内置支持，将于 **2025年11月30日** 正式移除

## [0.13.2] - 2025-11-23

### 调整

- **百度智能云** 提供商名称调整为产品名称 **百度千帆**

## [0.13.1] - 2025-11-23

### 新增

- **AI Ping** 提供商新增可用模型：`Kimi-K2-Thinking`

### 调整

- **心流AI(iFlow)** 提供商移除不兼容及已下线的模型：`DeepSeek-V3-671B`、`Qwen3-Coder-480B-A35B`

## [0.13.0] - 2025-11-23

### 新增

- **MiniMax** 提供商新增 `Coding Plan 编程套餐` 用量查询支持，状态栏显示套餐周期使用比例。
- **Kimi For Coding** 提供商新增用量查询支持，状态栏显示周期剩余额度.

## [0.12.4] - 2025-11-21

- **智谱AI** 提供商 联网搜索MCP 相关描述调整，编程套餐全挡位支持MCP调用
    - 所有挡位的编程套餐均已支持调用：Lite(100次)、Pro(1000次)、Max(4000次)。

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

---

## 早期版本

早期版本实现了扩展的核心功能和基础架构，包括：

- **多提供商支持**：智谱AI、心流AI、MoonshotAI、DeepSeek、MiniMax 等模型提供商接入
- **国内云厂商支持**：阿里云百炼、火山方舟、百度智能云、ModelScope、快手万擎等云厂商集成
- **联网搜索**：智谱AI网络搜索工具集成，支持 MCP SDK 客户端连接
- **编辑工具优化**：支持多种编辑工具模式（Claude/GPT-5/Grok）
- **配置系统**：支持 temperature、topP、maxTokens 等参数配置，支持提供商配置覆盖
- **Token 计算**：集成 @microsoft/tiktokenizer 进行 token 计算
- **多 SDK 支持**：集成 OpenAI SDK 和 Anthropic SDK 处理不同模型请求
- **思维链输出**：思维模型支持输出推理过程
- **兼容模式支持**：OpenAI / Anthropic 兼容模式，支持自定义 API 接入
- **自动重试机制**：`ModelScope`及`OpenAI / Anthropic 兼容模式`支持 429 状态码自动重试，减少 Agent 操作中断
