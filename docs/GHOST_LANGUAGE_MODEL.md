# Ghost Language Model - 使用 VS Code 语言模型 API

## 概述

Ghost 现在支持两种模型实现：

1. **GhostModel**（原实现）：直接调用智谱 API
2. **GhostLanguageModel**（新实现）：使用 VS Code Language Model API

## VS Code Language Model API 的优势

### ✅ 优势

1. **无需 API Key**
   - 使用用户已有的 GitHub Copilot 订阅
   - 不需要额外配置密钥

2. **零成本**
   - GitHub Copilot 对扩展开发者免费
   - 不产生额外费用

3. **多模型支持**
   - 自动使用用户选择的模型（如 GPT-4o）
   - 支持未来新增的模型

4. **更好的集成**
   - 原生 VS Code API
   - 遵循 VS Code 的权限和配额管理

5. **自动适配**
   - 不需要处理不同 API 的差异
   - 不需要担心 API 版本更新

### ❌ 限制

1. **需要 GitHub Copilot**
   - 用户必须有 Copilot 订阅
   - 不支持其他 AI 服务（如智谱）

2. **Token 统计不精确**
   - API 不返回实际的 token 使用量
   - 只能估算

3. **功能受限**
   - 不支持自定义参数（如 temperature）
   - 不支持 streaming 回调的细粒度控制

## 使用方法

### 1. 基本使用

```typescript
import { GhostLanguageModel } from './GhostLanguageModel';

const model = new GhostLanguageModel();

// 生成补全
const result = await model.generateCompletion(
    systemPrompt,
    userPrompt,
    chunk => {
        if (chunk.type === 'text') {
            console.log('收到文本:', chunk.text);
        } else if (chunk.type === 'usage') {
            console.log('Token 使用:', chunk.usage);
        }
    },
    token
);

console.log('完整结果:', result.text);
console.log('估算的 tokens:', result.usage);
```

### 2. 配置模型

```typescript
// 默认使用 GitHub Copilot 的 GPT-4o
model.setModelConfig('copilot', 'gpt-4o');

// 使用其他模型（如果可用）
model.setModelConfig('copilot', 'gpt-4');
```

### 3. 在 GhostInlineProvider 中集成

#### 方式 A：替换现有模型

```typescript
// 修改 GhostInlineProvider.ts
import { GhostLanguageModel } from './GhostLanguageModel';

export class GhostInlineProvider implements vscode.InlineCompletionItemProvider {
    // 替换模型
    private model: GhostLanguageModel;

    constructor(context: vscode.ExtensionContext) {
        this.model = new GhostLanguageModel();
        // ... 其他初始化
    }
}
```

#### 方式 B：配置切换

```typescript
// 在配置中添加选项
"gcmp.ghost.modelProvider": {
    "type": "string",
    "enum": ["vscode", "zhipu"],
    "default": "vscode",
    "description": "模型提供商：vscode (GitHub Copilot) 或 zhipu (智谱AI)"
}

// 在代码中根据配置选择
constructor(context: vscode.ExtensionContext) {
    const provider = config.get('modelProvider', 'vscode');
    
    if (provider === 'vscode') {
        this.model = new GhostLanguageModel();
    } else {
        this.model = new GhostModel();
    }
}
```

## API 参考

### selectChatModels

选择可用的聊天模型：

```typescript
const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',  // 供应商：copilot, openai, anthropic 等
    family: 'gpt-4o'    // 模型系列：gpt-4o, gpt-4, claude-3 等
});
```

### sendRequest

发送聊天请求：

```typescript
const response = await model.sendRequest(
    messages,
    {
        justification: 'Ghost AI code completion',  // 用途说明
        // 其他选项...
    },
    cancellationToken
);
```

### 错误处理

```typescript
try {
    const result = await model.generateCompletion(...);
} catch (error) {
    if (error instanceof vscode.LanguageModelError) {
        switch (error.code) {
            case vscode.LanguageModelError.NotFound.name:
                // 模型不存在
                break;
            case vscode.LanguageModelError.NoPermissions.name:
                // 没有权限
                break;
            case vscode.LanguageModelError.Blocked.name:
                // 请求被阻止
                break;
        }
    }
}
```

## 配置示例

### package.json

```json
{
    "contributes": {
        "configuration": {
            "properties": {
                "gcmp.ghost.modelProvider": {
                    "type": "string",
                    "enum": ["vscode", "zhipu"],
                    "enumDescriptions": [
                        "使用 VS Code 语言模型 (GitHub Copilot)",
                        "使用智谱 AI API"
                    ],
                    "default": "vscode",
                    "description": "代码补全模型提供商"
                },
                "gcmp.ghost.vscode.vendor": {
                    "type": "string",
                    "default": "copilot",
                    "description": "VS Code 语言模型供应商"
                },
                "gcmp.ghost.vscode.family": {
                    "type": "string",
                    "default": "gpt-4o",
                    "description": "VS Code 语言模型系列"
                }
            }
        }
    }
}
```

## 性能对比

| 特性 | GhostModel (智谱) | GhostLanguageModel (VS Code) |
|------|------------------|------------------------------|
| **成本** | ¥0.0001/1K tokens | 免费（Copilot 订阅） |
| **配置复杂度** | 需要 API Key | 无需配置 |
| **响应速度** | ~1-2s | ~1-2s |
| **Token 统计** | 精确 | 估算 |
| **模型选择** | 固定（GLM-4.5-air） | 可选（GPT-4o, GPT-4等） |
| **自定义参数** | 支持 | 不支持 |
| **离线使用** | ❌ | ❌ |

## 迁移指南

### 从 GhostModel 迁移到 GhostLanguageModel

1. **安装依赖**：无需安装，VS Code API 内置

2. **修改导入**：
   ```typescript
   // 旧
   import { GhostModel } from './GhostModel';
   
   // 新
   import { GhostLanguageModel } from './GhostLanguageModel';
   ```

3. **更新初始化**：
   ```typescript
   // 旧
   this.model = new GhostModel();
   
   // 新
   this.model = new GhostLanguageModel();
   ```

4. **更新调用**（大部分兼容）：
   ```typescript
   // API 签名几乎相同
   const result = await this.model.generateCompletion(
       systemPrompt,
       userPrompt,
       onChunk,
       token  // 注意：新实现支持 cancellation token
   );
   ```

5. **移除 API Key 配置**（可选）：
   - 不再需要智谱 API Key
   - 可以保留作为备选方案

## 最佳实践

### 1. 提供降级方案

```typescript
async function initializeModel() {
    try {
        // 优先尝试 VS Code 语言模型
        const model = new GhostLanguageModel();
        await model.initialize();
        
        if (model.hasValidCredentials()) {
            return model;
        }
    } catch (error) {
        Logger.warn('VS Code 语言模型不可用，降级到智谱 API');
    }
    
    // 降级到智谱 API
    return new GhostModel();
}
```

### 2. 用户友好的错误提示

```typescript
try {
    const result = await model.generateCompletion(...);
} catch (error) {
    if (error instanceof vscode.LanguageModelError) {
        if (error.code === vscode.LanguageModelError.NoPermissions.name) {
            vscode.window.showErrorMessage(
                'Ghost 需要访问语言模型权限。请在设置中启用 GitHub Copilot。',
                '打开设置'
            ).then(selection => {
                if (selection === '打开设置') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot');
                }
            });
        }
    }
}
```

### 3. 监听模型变化

```typescript
context.subscriptions.push(
    vscode.lm.onDidChangeChatModels(() => {
        Logger.info('可用的语言模型已更改');
        void model.reload();
    })
);
```

## 常见问题

### Q: 需要 GitHub Copilot 订阅吗？
A: 是的，VS Code Language Model API 主要使用 GitHub Copilot 的模型。

### Q: 可以使用其他模型吗？
A: 理论上可以，但取决于 VS Code 和扩展生态的支持。目前主要是 Copilot。

### Q: Token 统计准确吗？
A: 不准确，VS Code API 不返回实际使用量，只能估算。

### Q: 是否收费？
A: GitHub Copilot 对扩展开发者免费，不会产生额外费用。

### Q: 如何在两种实现之间切换？
A: 通过配置选项 `gcmp.ghost.modelProvider` 切换。

## 相关资源

- [VS Code Language Model API 文档](https://code.visualstudio.com/api/extension-guides/language-model)
- [GitHub Copilot 扩展 API](https://docs.github.com/en/copilot/building-copilot-extensions)
- [Language Model Chat API Reference](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChat)

---

最后更新：2025-01-16
