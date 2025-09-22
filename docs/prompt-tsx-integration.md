# 集成 @vscode/prompt-tsx 指南

## 📋 概述

本指南展示了如何在 GCMP 项目中集成 `@vscode/prompt-tsx` 库，以及我们创建的增强型提示处理系统。

## 🎯 已实现的功能

### 1. 增强的提示构建器 (`EnhancedPromptBuilder`)

**主要特性：**

- ✅ 结构化的消息构建
- ✅ 聊天历史管理
- ✅ 系统提示配置
- ✅ 工具调用历史处理

**使用示例：**

```typescript
import { createPromptBuilder } from '../prompts';

const builder = createPromptBuilder({
    systemPrompt: '你是一个专业的编程助手',
    includeHistory: true,
    maxHistoryTurns: 10
});

builder
    .addSystemMessage('专注于代码质量和最佳实践')
    .addUserMessage('请帮我重构这段代码')
    .addHistoryFromContext(chatContext);

const messages = builder.build();
```

### 2. 工具调用处理器 (`ToolCallProcessor`)

**主要特性：**

- ✅ 工具调用轮次管理
- ✅ 工具结果缓存
- ✅ 待处理状态跟踪

**使用示例：**

```typescript
import { createToolCallProcessor } from '../prompts';

const processor = createToolCallProcessor();

// 添加工具调用轮次
processor.addToolCallRound('正在搜索相关信息...', toolCallParts);

// 设置工具结果
processor.setToolResult(toolCallId, result);

// 检查是否有待处理的工具调用
if (processor.hasPendingToolCalls()) {
    // 处理待处理的工具调用
}
```

### 3. 增强的 OpenAI 处理器 (`EnhancedOpenAIHandler`)

**主要改进：**

- ✅ 集成提示构建器
- ✅ 更好的工具调用处理
- ✅ 增强的流式响应处理
- ✅ 聊天历史自动管理

## 🔧 集成到现有项目

### 步骤 1: 更新 GenericModelProvider

在 `GenericModelProvider` 中添加对增强处理器的支持：

```typescript
// 在 genericModelProvider.ts 中
import { EnhancedOpenAIHandler } from '../utils/enhancedOpenaiHandler';

export class GenericModelProvider implements LanguageModelChatProvider {
    private readonly openaiHandler: OpenAIHandler;
    private readonly enhancedHandler: EnhancedOpenAIHandler; // 新增

    constructor(providerKey: string, providerConfig: ProviderConfig) {
        // 现有代码...

        // 创建增强处理器
        this.enhancedHandler = new EnhancedOpenAIHandler(
            providerKey,
            providerConfig.displayName,
            providerConfig.baseUrl
        );
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 选择使用增强处理器还是原版处理器
        const useEnhanced = ConfigManager.getUseEnhancedPrompts();

        if (useEnhanced) {
            await this.enhancedHandler.handleRequest(model, messages, options, progress, token);
        } else {
            await this.openaiHandler.handleRequest(model, messages, options, progress, token);
        }
    }
}
```

### 步骤 2: 添加配置选项

在 `package.json` 中添加新的配置项：

```json
{
    "contributes": {
        "configuration": {
            "properties": {
                "gcmp.useEnhancedPrompts": {
                    "type": "boolean",
                    "default": false,
                    "description": "使用增强的提示处理器，提供更好的聊天历史管理和工具调用处理"
                }
            }
        }
    }
}
```

### 步骤 3: 更新 ConfigManager

在 `configManager.ts` 中添加新配置的获取方法：

```typescript
export class ConfigManager {
    // 现有方法...

    /**
     * 获取是否使用增强提示处理器
     */
    static getUseEnhancedPrompts(): boolean {
        return vscode.workspace.getConfiguration('gcmp').get('useEnhancedPrompts', false);
    }
}
```

## 📊 性能对比

| 特性     | 原版 OpenAIHandler | 增强版 EnhancedOpenAIHandler |
| -------- | ------------------ | ---------------------------- |
| 消息构建 | 手动转换           | 结构化构建器 ✅              |
| 聊天历史 | 基础处理           | 智能管理 ✅                  |
| 工具调用 | 分块处理           | 轮次管理 ✅                  |
| 错误处理 | 基础重抛           | 分类处理 ✅                  |
| 可维护性 | 中等               | 高 ✅                        |

## 🚀 高级用法

### 1. 自定义提示模板

```typescript
const builder = createPromptBuilder({
    systemPrompt: `
你是一个专业的 ${language} 开发者。
请遵循以下原则：
- 代码质量第一
- 性能优化
- 最佳实践
    `.trim()
});
```

### 2. 工具调用链

```typescript
const processor = createToolCallProcessor();

// 第一轮工具调用
processor.addToolCallRound('搜索相关文档...', searchToolCalls);

// 第二轮工具调用
processor.addToolCallRound('分析搜索结果...', analysisToolCalls);

// 获取完整的工具调用历史
const history = processor.getToolCallRounds();
```

### 3. 条件化增强

```typescript
// 根据模型能力选择处理器
const useEnhanced = model.capabilities?.toolCalling && ConfigManager.getUseEnhancedPrompts();

if (useEnhanced) {
    await this.enhancedHandler.handleRequest(/* ... */);
} else {
    await this.openaiHandler.handleRequest(/* ... */);
}
```

## 📝 注意事项

1. **向后兼容性**: 增强版处理器完全向后兼容，可以作为原版的直接替换
2. **性能影响**: 增强功能会带来轻微的性能开销，但提供了更好的用户体验
3. **配置灵活性**: 用户可以选择是否启用增强功能
4. **渐进式采用**: 可以在特定场景下逐步启用增强功能

## 🔮 未来扩展

1. **模板系统**: 支持预定义的提示模板
2. **缓存优化**: 实现智能的消息缓存机制
3. **插件架构**: 支持自定义的提示处理插件
4. **分析工具**: 提供提示效果分析和优化建议

## 📚 相关资源

- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [@vscode/prompt-tsx 文档](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample)
- [OpenAI API 参考](https://platform.openai.com/docs/api-reference)
