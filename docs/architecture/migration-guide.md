# GCMP 模块化迁移指南

## 概述

本指南为开发者和用户提供从单体 GCMP 扩展迁移到模块化生态系统的详细步骤。

## 用户迁移指南

### 自动迁移（推荐）

#### 1. 备份当前配置

```bash
# 导出当前配置
code --export-extensions-ids > extensions-backup.txt
```

#### 2. 卸载旧版本

1. 打开 VS Code
2. 进入扩展面板 (Ctrl+Shift+X)
3. 搜索 "AI Chat Models" 或 "gcmp"
4. 点击卸载

#### 3. 安装新架构

```bash
# 安装集成包（自动包含核心功能）
code --install-extension @gcmp/integration

# 或在VS Code扩展市场搜索 "GCMP Integration"
```

#### 4. 配置迁移

新安装时会自动检测并迁移现有配置：

- API 密钥设置
- 模型偏好设置
- 全局配置选项

### 手动迁移

#### 1. 保存配置信息

在迁移前，记录以下信息：

```json
// 在VS Code设置中查找 gcmp.* 配置
{
    "gcmp.temperature": 0.7,
    "gcmp.topP": 0.9,
    "gcmp.maxTokens": 2048,
    "gcmp.zhipu.search.enableMCP": true
}
```

#### 2. 记录已设置的API密钥

检查哪些供应商已设置API密钥，以便在新架构中重新设置。

#### 3. 安装所需供应商

```bash
# 根据需要安装特定供应商
code --install-extension @gcmp/provider-zhipu
code --install-extension @gcmp/provider-iflow
code --install-extension @gcmp/provider-moonshot
# ... 其他供应商
```

#### 4. 重新配置

1. 打开命令面板 (Ctrl+Shift+P)
2. 执行 `gcmp.{provider}.setApiKey` 命令
3. 输入之前保存的API密钥

## 开发者迁移指南

### 项目结构调整

#### 1. 新的目录结构

```
gcmp-ecosystem/
├── packages/
│   ├── core/                    # 核心包
│   ├── provider-{name}/         # 各供应商包
│   └── integration/             # 集成包
├── tools/                       # 开发工具
├── docs/                        # 文档
└── scripts/                     # 构建脚本
```

#### 2. 依赖关系变化

```typescript
// 旧方式
import { GenericModelProvider } from './providers/genericModelProvider';
import { ConfigManager } from './utils/configManager';

// 新方式
import { BaseModelProvider, ConfigManager } from '@gcmp/core';
```

### 代码迁移步骤

#### 1. 更新导入语句

```typescript
// 旧的导入
import { Logger, ApiKeyManager } from './utils';
import { ProviderConfig } from './types/sharedTypes';

// 新的导入
import { Logger, ApiKeyManager } from '@gcmp/core';
import { ProviderConfig } from '@gcmp/core/types';
```

#### 2. 继承基类变化

```typescript
// 旧方式
export class CustomProvider implements vscode.LanguageModelChatProvider {
    // 完整实现所有接口方法
}

// 新方式
export class CustomProvider extends BaseModelProvider {
    protected createChatProviderInternal(modelId: string) {
        // 只需实现特定逻辑
    }
}
```

#### 3. 配置文件位置

```json
// 旧位置
src/providers/config/{provider}.json

// 新位置
packages/provider-{provider}/src/config/provider.json
```

### 新供应商开发指南

#### 1. 创建供应商包

```bash
# 使用脚手架工具
npm run create:provider -- my-provider

# 或手动创建
mkdir packages/provider-my-provider
cd packages/provider-my-provider
npm init -y
```

#### 2. 基础文件结构

```
packages/provider-my-provider/
├── src/
│   ├── config/
│   │   └── provider.json
│   ├── provider/
│   │   └── myProvider.ts
│   ├── extension.ts
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

#### 3. 供应商配置示例

```json
{
    "displayName": "My AI Provider",
    "baseUrl": "https://api.myprovider.com/v1",
    "apiKeyTemplate": "sk-{apiKey}",
    "models": [
        {
            "id": "my-model",
            "name": "My Model",
            "tooltip": "My AI Model for Chat",
            "maxInputTokens": 4096,
            "maxOutputTokens": 2048,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
            }
        }
    ]
}
```

#### 4. 供应商实现示例

```typescript
// src/provider/myProvider.ts
import { BaseModelProvider } from '@gcmp/core';
import { GenericChatProvider } from './genericChatProvider';

export class MyProvider extends BaseModelProvider {
    constructor() {
        const config = require('../config/provider.json');
        super('myprovider', 'My AI Provider', config);
    }

    protected createChatProviderInternal(modelId: string) {
        return new GenericChatProvider(this.providerKey, this.displayName, this.config, modelId);
    }

    protected getToolsInternal() {
        return []; // 如有特殊工具，在此返回
    }
}
```

#### 5. 扩展入口

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { MyProvider } from './provider/myProvider';
import { getCoreAPI } from '@gcmp/core';

let provider: MyProvider;

export async function activate(context: vscode.ExtensionContext) {
    const coreAPI = await getCoreAPI();
    if (!coreAPI) {
        throw new Error('GCMP Core not found');
    }

    provider = new MyProvider();
    await provider.activate(context);
    coreAPI.registerProvider(provider);
}

export async function deactivate() {
    if (provider) {
        await provider.deactivate();
    }
}
```

## 构建和发布

### 开发环境设置

#### 1. 安装依赖

```bash
# 安装根依赖
npm install

# Bootstrap所有包
npm run bootstrap
```

#### 2. 开发命令

```bash
# 构建所有包
npm run build

# 运行所有测试
npm run test

# 启动开发模式
npm run dev

# 代码检查
npm run lint
```

### 发布流程

#### 1. 版本管理

```bash
# 更新特定包版本
npm run version:provider -- zhipu

# 更新所有包版本
npm run version:all
```

#### 2. 发布到npm

```bash
# 发布所有包
npm run publish:all

# 发布特定包
npm run publish:provider -- zhipu
```

#### 3. 发布到VS Code市场

```bash
# 构建VSIX包
npm run package:integration

# 发布到市场
npm run publish:vscode
```

## 故障排除

### 常见问题

#### 1. 扩展无法激活

**症状**：VS Code显示扩展激活失败
**解决方案**：

```bash
# 检查依赖
npm ls @gcmp/core

# 重新构建
npm run clean && npm run build

# 检查日志
# View -> Output -> GCMP Integration
```

#### 2. 供应商未被发现

**症状**：模型选择器中缺少某些供应商
**解决方案**：

1. 确认供应商扩展已安装
2. 检查扩展是否激活
3. 查看输出面板的错误信息

#### 3. API密钥丢失

**症状**：需要重新设置API密钥
**解决方案**：

1. 这是正常现象，新架构使用不同的存储机制
2. 重新设置API密钥：`Ctrl+Shift+P` -> `gcmp.{provider}.setApiKey`

#### 4. 配置不生效

**症状**：更改配置后没有效果
**解决方案**：

```bash
# 重启VS Code
# 或重新加载窗口
Ctrl+Shift+P -> "Developer: Reload Window"
```

### 调试技巧

#### 1. 启用详细日志

```json
// VS Code settings.json
{
    "gcmp.debug.enabled": true,
    "gcmp.debug.level": "trace"
}
```

#### 2. 检查扩展状态

```typescript
// 在开发者控制台中运行
const extensions = vscode.extensions.all.filter(e => e.id.startsWith('@gcmp/'));
console.log(extensions.map(e => ({ id: e.id, active: e.isActive })));
```

#### 3. 查看注册的供应商

```typescript
// 获取核心API并检查供应商
const coreAPI = await getCoreAPI();
const providers = coreAPI.getAllProviders();
console.log(providers.map(p => ({ key: p.providerKey, name: p.displayName })));
```

## 性能优化

### 延迟加载

```typescript
// 实现供应商的延迟加载
export class LazyProviderLoader {
    private loaders = new Map<string, () => Promise<IGCMPProvider>>();

    registerProvider(key: string, loader: () => Promise<IGCMPProvider>) {
        this.loaders.set(key, loader);
    }

    async loadProvider(key: string): Promise<IGCMPProvider> {
        const loader = this.loaders.get(key);
        if (!loader) {
            throw new Error(`Provider ${key} not found`);
        }
        return loader();
    }
}
```

### 缓存机制

```typescript
// 实现配置缓存
export class ConfigCache {
    private cache = new Map<string, any>();
    private ttl = 5 * 60 * 1000; // 5分钟

    get(key: string): any | undefined {
        const item = this.cache.get(key);
        if (item && Date.now() - item.timestamp < this.ttl) {
            return item.value;
        }
        return undefined;
    }

    set(key: string, value: any): void {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }
}
```

## 最佳实践

### 1. 版本兼容性

- 遵循语义化版本控制
- 保持API向后兼容
- 提供迁移指南

### 2. 代码质量

- 使用TypeScript严格模式
- 保持高测试覆盖率
- 遵循代码规范

### 3. 文档维护

- 及时更新API文档
- 提供使用示例
- 维护变更日志

### 4. 社区支持

- 响应issue和PR
- 提供技术支持
- 收集用户反馈

## 总结

通过本迁移指南，用户和开发者可以顺利地从单体GCMP扩展迁移到模块化生态系统。新架构提供了更好的可维护性、可扩展性和用户体验，同时保持了向后兼容性。

如果在迁移过程中遇到问题，请参考故障排除部分或联系技术支持团队。
