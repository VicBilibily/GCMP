# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.22.12] - 2026-05-15

### 新增

- **ChatGPT 用量重置倒计时**：在状态栏 Tooltip 的用量表格中增加倒计时列（如 `4d 13h`、`13m`、`30s`），便于直观感知额度重置时间（[#175](https://github.com/VicBilibily/GCMP/pull/175)）
- **火山方舟 Agent Plan**：新增 **DeepSeek-V4-Flash-Beta**、**DeepSeek-V4-Pro-Beta** 模型
- **阿里云百炼**：新增模型 **Qwen3.6-Flash**
    - **Token Plan**：新增模型 **Qwen3.6-Flash**、**GLM-5.1**、**Kimi-K2.6**、**Kimi-K2.5**、**DeepSeek-V4-Pro**、**DeepSeek-V4-Flash**

### 移除

- **`autoPrefixModelId` 配置项**：模型 ID 前缀模式（`gcmp.${provider}:::${modelId}`）已作为默认行为内置，移除 `gcmp.autoPrefixModelId` 开关及其关联代码
- **Copilot Chat 扩展依赖声明**：移除 `extensionDependencies` 中的 `github.copilot-chat` 硬依赖，改为激活时尝试拉起 Copilot Chat

## [0.22.11] - 2026-05-13

### 修复

- **MiMo 多轮工具调用推理丢失**：重构思考内容回放策略，修复 MiMo 模型在多轮工具调用场景下 `reasoning_content` 未正确传回 API 导致请求失败的问题（[#171](https://github.com/VicBilibily/GCMP/issues/171)）
    - 提取通用策略模块 `reasoningReplayPolicy`，替代原 DeepSeek-V4 硬编码逻辑
    - OpenAI 与 Anthropic 两条转换路径均已适配
- **工具调用参数解析失败**：修复 `deduplicateToolArgs` 误删单字符标点导致工具调用参数解析失败的问题（[#173](https://github.com/VicBilibily/GCMP/pull/173)）

### 优化

- **模型计费描述统一**：统一将模型名称中的"按量计费"和"按量付费"更改为 **PayGo**，涵盖智谱AI、MiniMax、快手万擎、腾讯云、百度千帆等提供商

## [0.22.10] - 2026-05-11

### 新增

- **百度千帆**：新增 **ERNIE-5.1** 按量计费模型

### 修复

- **VS Code 1.120.0 模型不显示**：修复 VS Code 1.120.0 及以上版本无法识别第三方模型的问题，补齐 `isUserSelectable` 属性声明（[#159](https://github.com/VicBilibily/GCMP/issues/159)）

## [0.22.9] - 2026-05-09

### 新增

- **百度千帆**：新增 DeepSeek-V4 系列模型
    - **Coding Plan**：**DeepSeek-V4-Flash**、**GLM-5.1**
    - **按量计费**：**DeepSeek-V4-Flash**、**DeepSeek-V4-Pro**

### 修复

- **请求中止残留空消息**：修复用户取消请求后，VS Code 保留的空 assistant 消息（仅含空白文本与空代码块）导致后续请求随机缓存命中暴降的问题（[#157](https://github.com/VicBilibily/GCMP/issues/157)）

## [0.22.8] - 2026-05-08

### 新增

- **火山方舟 Agent Plan**：新增 Agent Plan 套餐支持
    - **豆包模型**：**Doubao-Seed-2.0**(Code/pro/lite/mini)
    - **开源模型**：**GLM-5.1**、**MiniMax-M2.7**、**Kimi-K2.6**、**DeepSeek-V3.2**
- **火山方舟多密钥管理**：支持 Coding Plan 与 Agent Plan 独立密钥配置
- **火山方舟配置向导**：新增交互式配置向导，引导用户正确设置不同套餐的专用 API Key

### 移除

- **火山方舟**：移除即将下线的 **Doubao-Seed-1.6** 与 **DeepSeek-V3.1** 模型

## [0.22.7] - 2026-05-06

### 优化

- **Commit 默认读取策略**：提交消息生成默认入口改为优先读取暂存区，若暂存区无变更则自动回退到未提交工作树，无需手动选择
- **Commit 来源提示**：生成完成后提示信息显示实际使用的变更来源（暂存区 / 工作树）

### 更新

- **火山方舟 Doubao Seed 2.0**：Doubao-Seed-2.0-mini 与 Doubao-Seed-2.0-lite 更新为 260428 版本

## [0.22.6] - 2026-04-28

### 修复

- **火山方舟 Seed 2.0 推理强度**：修复使用 Anthropic 接口的火山模型选择 `minimal` 推理强度时，错误地将 `minimal` 传递到请求体导致 API 报错的问题；`minimal` 现在正确映射为关闭思考模式（[#149](https://github.com/VicBilibily/GCMP/issues/149)）

## [0.22.5] - 2026-04-28

### 修复

- **提交消息生成失败**：修复 DeepSeek-V4 等默认开启思考的模型在生成提交消息时报错 `thinking options type cannot be disabled when reasoning_effort is set` 的问题（[#148](https://github.com/VicBilibily/GCMP/issues/148)）
    - Anthropic SDK：提交模式下禁用思考时同步移除 `output_config`，避免参数冲突
    - OpenAI SDK：提交模式下 `thinkingFormat=object` 时同步移除 `reasoning_effort`；`thinkingFormat=boolean` 时仅当关闭选项为首项配置才传递 `reasoning_effort` 关闭思考，其余由 `enable_thinking=false` 直接关闭
    - Responses API：提交模式下无条件设置 `thinking.type=disabled`，并显式补齐 `reasoning.effort` 关闭值（`none`/`minimal`），不再依赖请求中是否已有 reasoning 字段

## [0.22.4] - 2026-04-25

### 移除

- **Moonshot**：移除 Moonshot 配置中的 `customHeader`（`HTTP-Referer`、`X-Title`、`User-Agent`）

## [0.22.3] - 2026-04-25

### 新增

- **阿里云百炼**：新增 **DeepSeek-V4-Flash** 与 **DeepSeek-V4-Pro** 按量付费模型
- **腾讯云 TokenHub**：新增 **DeepSeek-V4-Flash** 与 **DeepSeek-V4-Pro** 按量付费模型

## [0.22.2] - 2026-04-24

### 修复

- **扩展激活失败**：修复 usages 缓存文件损坏时可能导致扩展启动阶段 JSON 解析异常、进而无法激活的问题（[#143](https://github.com/VicBilibily/GCMP/issues/143)）
- **用量缓存写入可靠性**：`usages/index.json` 与各日期 `stats.json` 改为串行化的原子写入，降低并发覆盖或中断写入导致缓存文件损坏的风险

## [0.22.1] - 2026-04-24

### 新增

- **MiniMax**：[#122](https://github.com/VicBilibily/GCMP/pull/122) [#135](https://github.com/VicBilibily/GCMP/issues/135) Coding Plan 模型支持图片输入，通过对话图片桥接的独立模块实现，利用 Vision API 将图片自动转为文字描述

## [0.22.0] - 2026-04-24

### 新增

- **DeepSeek**：全面升级至 DeepSeek V4 系列模型
    - 新增模型：**DeepSeek-V4 Flash**（快速模式）、**DeepSeek-V4 Pro**（专家模式）
    - 上下文窗口 1M tokens，最大输出 384K tokens
    - 支持推理深度控制（`high` / `max` / `none`）
- **腾讯云**：新增腾讯混元模型 **HY 3 Preview**

### 优化

- **Commit 提示词**：为 commit 消息生成添加 System Role 消息（[#138](https://github.com/VicBilibily/GCMP/issues/138)）

## 历史版本（仅保留功能日志）

### 0.21.0 - 0.21.20 (2026-03-27 - 2026-04-23)

- **百度千帆**：新增百度千帆大模型平台提供商支持
- **腾讯云**：新增腾讯云大模型服务平台 TokenHub 按量付费模型接入
- **Xiaomi MIMO**：新增 Token Plan 套餐接入与专用 API Key 配置
- **联网搜索工具**：新增 `#kimiWebSearch`、`#bailianWebSearch` 联网搜索工具支持
- **模型配置能力**：新增模型级 `thinking`、`reasoningEffort` 选项，允许手动调整模型思考模式及思考强度
- **请求重试机制**：统一由通用 Provider 处理自动重试，新增 `gcmp.retry.maxAttempts` 配置项
- **移除**：移除 Qwen Code CLI、iFlow CLI 认证提供商

### 0.20.0 - 0.20.11 (2026-03-05 - 2026-03-23)

- **Codex CLI 认证支持**：新增 OpenAI Codex (Codex CLI) 提供商支持
- **腾讯云**：新增提供商支持，包含混元模型、Coding Plan 编程套餐、DeepSeek 接入及多密钥管理
- **Xiaomi MIMO**：新增提供商支持，包含 MiMo-V2 系列模型
- **模型 Family 配置**：新增模型级别的 `family` 配置项
- **临时兼容配置项**：新增 `gcmp.autoPrefixModelId` 配置项，适配 VS Code 1.111.0 模型选择器

### 0.19.0 - 0.19.17 (2026-02-12 - 2026-02-28)

- **功能优化**：重构 Token 统计缓存机制、优化状态栏统一显示剩余百分比、API Key 输入体验优化、Anthropic cache_control 兼容性改进

### 0.18.0 - 0.18.30 (2026-01-23 - 2026-02-11)

- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
- **Token 统计**：新增完整的 Token 消耗统计系统，包括平均输出速度、首 Token 延迟、小时统计图表等可视化功能
- **MistralAI**：新增 MistralAI 提供商支持，支持 Codestral 系列模型 FIM/NES 代码补全功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格
- **阿里云百炼**：新增 Coding Plan 套餐专属模型接入

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **CLI 认证支持**：新增 CLI 工具认证模式，支持 Qwen Code CLI、Gemini CLI 进行 OAuth 认证
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
