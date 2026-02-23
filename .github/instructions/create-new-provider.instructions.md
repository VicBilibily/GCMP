---
description: 创建新模型提供商（provider）时的改动清单与验证要点（配置、注册、API Key、运行与调试）。
---

创建新模型提供商的简要要点：

- 在 `src/providers/config/` 添加提供商配置 JSON 文件，包含 displayName、baseUrl、apiKeyTemplate、models 等必要字段。
    - 如支持 Coding Plan 等专用密钥，可添加可选字段 `codingKeyTemplate` 用于指示专用 API Key 格式。
- 在 `src/providers/config/index.ts` 导入并导出该配置，使 `ConfigManager` 能自动读取。
- 在 `package.json` 中同步注册：
    - 在 `activationEvents` 添加 `onLanguageModelProvider:gcmp.<providerKey>`。
    - 在 `contributes.commands` 添加 `gcmp.<providerKey>.setApiKey`（用于设置 API Key）。
    - 在 `contributes.languageModelChatProviders` 添加对应 vendor 项，使模型选择器显示该提供商。
- 使用现有 `GenericModelProvider` 处理 OpenAI 兼容的运行时代码；如需动态模型或特殊逻辑，可参考 `IFlowDynamicProvider`。
- 使用 `ApiKeyManager` 提示并保存 API Key，确保在发送请求前已存在有效密钥。
- 验证要点：
    - `ConfigManager.getConfigProvider()` 返回包含新提供商的配置。
    - 执行编译（`npm run compile:dev`）无错误。
    - 在 VS Code 启动（F5）后，模型选择器中能看到新提供商并能用 `gcmp.<providerKey>.setApiKey` 设置密钥。
- 调试提示：检查输出通道日志、确认 `package.json` 的 vendor 名称与配置 key 一致、如需特殊 SSE/流式兼容在 `OpenAIHandler` 中添加 provider-specific 处理。
