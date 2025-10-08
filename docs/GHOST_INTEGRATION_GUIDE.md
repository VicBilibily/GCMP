# Ghost 模型集成指南

## 快速开始

### 方式 1：仅使用 VS Code Language Model（推荐）

直接在 `GhostInlineProvider.ts` 中替换模型：

```typescript
// 旧的导入
import { GhostModel } from './GhostModel';

// 新的导入
import { GhostLanguageModel } from './GhostLanguageModel';

// 在构造函数中
constructor(context: vscode.ExtensionContext) {
    // 旧
    // this.model = new GhostModel();
    
    // 新
    this.model = new GhostLanguageModel();
    
    // ... 其他代码保持不变
}
```

**优点**：
- ✅ 零配置，使用 GitHub Copilot
- ✅ 免费（Copilot 订阅包含）
- ✅ 代码改动最小

**缺点**：
- ❌ 需要 Copilot 订阅
- ❌ 无法使用智谱 API

---

### 方式 2：使用模型工厂（推荐，支持切换）

使用 `GhostModelFactory` 自动选择最佳模型：

```typescript
import { GhostModelFactory, type IGhostModel } from './GhostModelFactory';

export class GhostInlineProvider implements vscode.InlineCompletionItemProvider {
    private model: IGhostModel;
    
    constructor(context: vscode.ExtensionContext) {
        // 使用工厂创建模型（自动选择最佳）
        void this.initializeModel();
        
        // ... 其他初始化
    }
    
    private async initializeModel(): Promise<void> {
        // 自动选择：优先 VS Code，降级到智谱
        this.model = await GhostModelFactory.createBestAvailableModel();
        
        // 或者根据配置选择
        // this.model = await GhostModelFactory.createModel();
    }
}
```

**优点**：
- ✅ 自动降级（Copilot → 智谱）
- ✅ 支持用户配置切换
- ✅ 最佳用户体验

**缺点**：
- 需要等待异步初始化

---

### 方式 3：配置切换

添加配置项让用户选择：

#### 1. 修改 `package.json`

```json
{
    "contributes": {
        "configuration": {
            "properties": {
                "gcmp.ghost.modelProvider": {
                    "type": "string",
                    "enum": ["vscode", "zhipu", "auto"],
                    "enumDescriptions": [
                        "使用 VS Code 语言模型 (GitHub Copilot) - 推荐",
                        "使用智谱 AI API (需要配置 API Key)",
                        "自动选择最佳可用模型"
                    ],
                    "default": "auto",
                    "markdownDescription": "代码补全模型提供商\n\n- **vscode**: 使用 GitHub Copilot（免费，需要 Copilot 订阅）\n- **zhipu**: 使用智谱 AI（需要 API Key）\n- **auto**: 自动选择（优先 Copilot）"
                }
            }
        }
    }
}
```

#### 2. 修改 `GhostInlineProvider.ts`

```typescript
import { GhostModelFactory, type IGhostModel, type ModelProvider } from './GhostModelFactory';

export class GhostInlineProvider implements vscode.InlineCompletionItemProvider {
    private model: IGhostModel;
    
    constructor(context: vscode.ExtensionContext) {
        void this.initializeModel();
        
        // 监听配置变化
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async e => {
                if (e.affectsConfiguration('gcmp.ghost.modelProvider')) {
                    Logger.info('模型提供商配置已更改，重新初始化...');
                    await this.initializeModel();
                }
            })
        );
    }
    
    private async initializeModel(): Promise<void> {
        const config = vscode.workspace.getConfiguration('gcmp.ghost');
        const provider = config.get<string>('modelProvider', 'auto');
        
        if (provider === 'auto') {
            // 自动选择最佳模型
            this.model = await GhostModelFactory.createBestAvailableModel();
        } else {
            // 使用指定的模型
            this.model = await GhostModelFactory.createModel(provider as ModelProvider);
        }
        
        this.updateStatusBar();
    }
}
```

---

## 完整示例

### 修改后的 GhostInlineProvider.ts（关键部分）

```typescript
/*---------------------------------------------------------------------------------------------
 *  Ghost Inline Provider - InlineCompletionItemProvider 实现
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GhostModelFactory, type IGhostModel } from './GhostModelFactory';
import { GhostPromptBuilder } from './GhostPromptBuilder';
import { Logger } from '../../utils/logger';
import type { GhostConfig, GhostContext } from './types';

export class GhostInlineProvider implements vscode.InlineCompletionItemProvider {
    private model!: IGhostModel;  // 使用统一接口
    private config: GhostConfig;
    
    // ... 其他属性保持不变

    constructor(context: vscode.ExtensionContext) {
        this.config = this.loadConfig();
        
        // 异步初始化模型
        void this.initializeModel();

        // 创建状态栏
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        
        // 监听配置变化
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async e => {
                if (e.affectsConfiguration('gcmp.ghost')) {
                    this.config = this.loadConfig();
                    
                    // 如果模型提供商变化，重新初始化
                    if (e.affectsConfiguration('gcmp.ghost.modelProvider')) {
                        await this.initializeModel();
                    }
                    
                    this.updateStatusBar();
                }
            })
        );

        Logger.info('GhostInlineProvider 已初始化');
    }

    /**
     * 初始化模型
     */
    private async initializeModel(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.ghost');
            const provider = config.get<string>('modelProvider', 'auto');
            
            Logger.info(`Ghost: 初始化模型 (provider=${provider})`);
            
            if (provider === 'auto') {
                this.model = await GhostModelFactory.createBestAvailableModel();
            } else {
                this.model = await GhostModelFactory.createModel(provider as any);
            }
            
            this.updateStatusBar();
            Logger.info(`Ghost: 模型初始化完成 - ${this.model.getModelName()}`);
        } catch (error) {
            Logger.error('Ghost: 模型初始化失败', error);
            vscode.window.showErrorMessage('Ghost 代码补全初始化失败，请检查配置');
        }
    }

    /**
     * 更新状态栏
     */
    private updateStatusBar(): void {
        if (!this.model) {
            this.statusBarItem.text = '$(sparkle) Ghost ✗';
            this.statusBarItem.tooltip = 'Ghost AI Code Completion (未初始化)';
            return;
        }

        const model = this.model.getModelName();
        const status = this.model.hasValidCredentials() ? '✓' : '✗';

        let text = `$(sparkle) Ghost ${status}`;

        if (this.totalCost > 0) {
            text += ` | ¥${this.totalCost.toFixed(4)}`;
        }

        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = 
            `Ghost AI Code Completion\n` +
            `Model: ${model}\n` +
            `Status: ${status}\n` +
            `Total Cost: ¥${this.totalCost.toFixed(4)}`;
    }
    
    // ... 其他方法保持不变，generateCompletion 中的调用完全兼容
    
    private async generateCompletion(...): Promise<...> {
        // 调用方式保持不变
        const result = await this.model.generateCompletion(
            systemPrompt,
            userPrompt,
            chunk => {
                if (chunk.type === 'usage' && chunk.usage) {
                    this.lastCost = chunk.usage.cost;
                    this.totalCost += chunk.usage.cost;
                    this.updateStatusBar();
                }
            },
            token  // VS Code Language Model 支持 token
        );
        
        // ... 处理结果
    }
}
```

---

## 配置文件示例

### settings.json

```json
{
    // 方式 1: 自动选择（推荐）
    "gcmp.ghost.modelProvider": "auto",
    
    // 方式 2: 仅使用 GitHub Copilot
    // "gcmp.ghost.modelProvider": "vscode",
    
    // 方式 3: 仅使用智谱 API
    // "gcmp.ghost.modelProvider": "zhipu",
    
    // 智谱 API 配置（仅当使用 zhipu 时需要）
    "gcmp.ghost.modelId": "glm-4.5-air",
    
    // 其他配置
    "gcmp.ghost.showStatusBar": true
}
```

---

## 迁移步骤

### 1. 最小改动（仅使用 VS Code）

```typescript
// 1. 修改导入
- import { GhostModel } from './GhostModel';
+ import { GhostLanguageModel } from './GhostLanguageModel';

// 2. 修改初始化
- this.model = new GhostModel();
+ this.model = new GhostLanguageModel();
```

**完成！** 其他代码无需修改。

---

### 2. 完整迁移（支持切换）

1. **添加配置** (package.json)
2. **修改导入** (GhostInlineProvider.ts)
3. **使用工厂** (initializeModel)
4. **测试切换** (验证配置生效)

---

## 测试

### 测试 VS Code Language Model

```typescript
// 在 VS Code 调试控制台执行
const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
console.log('可用模型:', models.map(m => m.name));
```

### 测试模型工厂

```typescript
// 测试自动选择
const model = await GhostModelFactory.createBestAvailableModel();
console.log('选择的模型:', model.getModelName());
console.log('模型可用:', model.hasValidCredentials());
```

### 测试代码补全

1. 打开一个代码文件
2. 输入 `function test() { ` 并暂停
3. 查看状态栏显示的模型信息
4. 800ms 后应该出现补全建议

---

## 常见问题

### Q: 如何知道当前使用的是哪个模型？

A: 查看状态栏或日志：

```
[Info] Ghost: 初始化模型 (provider=auto)
[Info] ✓ 自动选择: VS Code 语言模型 (GitHub Copilot)
[Info] Ghost: 模型初始化完成 - copilot/gpt-4o
```

### Q: VS Code Language Model 不可用怎么办？

A: 模型工厂会自动降级：

```
[Warn] VS Code 语言模型不可用: ...
[Info] → 降级到智谱 API
[Info] ✓ 使用智谱 API 模型
```

### Q: 成本会增加吗？

A: 
- VS Code Language Model (Copilot): **免费**
- 智谱 API: **¥0.0001/1K tokens**

配置会正确显示成本（VS Code 显示 ¥0.0000）

---

## 推荐配置

### 推荐 1: 纯 VS Code（最简单）

```json
{
    "gcmp.ghost.modelProvider": "vscode"
}
```

**适用于**：有 GitHub Copilot 订阅的用户

---

### 推荐 2: 自动降级（最灵活）

```json
{
    "gcmp.ghost.modelProvider": "auto"
}
```

**适用于**：所有用户，自动选择最佳方案

---

### 推荐 3: 仅智谱（特定需求）

```json
{
    "gcmp.ghost.modelProvider": "zhipu",
    "gcmp.ghost.modelId": "glm-4.5-air"
}
```

**适用于**：不想使用 Copilot，或需要特定模型的用户

---

最后更新：2025-01-16
