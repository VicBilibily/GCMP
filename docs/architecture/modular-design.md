# GCMP 模块化架构设计文档

## 概述

本文档描述了 GCMP (GitHub Copilot Models Provider) 从单体扩展向模块化生态系统转型的架构设计。

## 设计目标

1. **模块化**：将各供应商拆分为独立扩展，降低维护复杂度
2. **可扩展性**：便于添加新供应商支持
3. **向后兼容**：保持现有用户体验不变
4. **独立发布**：各供应商可独立更新和发布
5. **按需安装**：用户可选择性安装需要的供应商

## 架构概览

### 包结构

```
gcmp-ecosystem/
├── packages/
│   ├── core/                    # 核心共享包 (@gcmp/core)
│   ├── provider-zhipu/          # 智谱AI扩展 (@gcmp/provider-zhipu)
│   ├── provider-iflow/          # 心流AI扩展 (@gcmp/provider-iflow)
│   ├── provider-moonshot/       # MoonshotAI扩展 (@gcmp/provider-moonshot)
│   ├── provider-deepseek/       # DeepSeek扩展 (@gcmp/provider-deepseek)
│   ├── provider-volcengine/     # 火山方舟扩展 (@gcmp/provider-volcengine)
│   ├── provider-dashscope/      # 阿里云百炼扩展 (@gcmp/provider-dashscope)
│   ├── provider-minimax/        # MiniMax扩展 (@gcmp/provider-minimax)
│   ├── provider-modelscope/     # 魔搭社区扩展 (@gcmp/provider-modelscope)
│   ├── provider-siliconflow/    # 硅基流动扩展 (@gcmp/provider-siliconflow)
│   ├── provider-infini/         # 无问芯穹扩展 (@gcmp/provider-infini)
│   ├── provider-coreshub/       # 基石智算扩展 (@gcmp/provider-coreshub)
│   ├── provider-tencentcloud/   # 腾讯云扩展 (@gcmp/provider-tencentcloud)
│   ├── provider-huaweicloud/    # 华为云扩展 (@gcmp/provider-huaweicloud)
│   ├── provider-jdcloud/        # 京东云扩展 (@gcmp/provider-jdcloud)
│   ├── provider-qiniu/          # 七牛云扩展 (@gcmp/provider-qiniu)
│   ├── provider-ucloud/         # UCloud扩展 (@gcmp/provider-ucloud)
│   ├── provider-paratera/       # 并行智算云扩展 (@gcmp/provider-paratera)
│   ├── provider-ppio/           # PPIO派欧云扩展 (@gcmp/provider-ppio)
│   ├── provider-lanyun/         # 蓝莺云扩展 (@gcmp/provider-lanyun)
│   ├── provider-sophnet/        # Sophnet扩展 (@gcmp/provider-sophnet)
│   ├── provider-baidu/          # 百度云扩展 (@gcmp/provider-baidu)
│   └── integration/             # 统一集成包 (@gcmp/integration)
├── tools/                       # 开发工具和脚本
└── docs/                        # 文档
```

## 核心包设计

### @gcmp/core

核心共享包，提供所有扩展的基础功能：

#### 目录结构

```
packages/core/
├── src/
│   ├── interfaces/              # 核心接口定义
│   │   ├── provider.ts          # 供应商接口
│   │   ├── tool.ts              # 工具接口
│   │   └── config.ts            # 配置接口
│   ├── types/                   # 类型定义
│   │   ├── sharedTypes.ts       # 共享类型
│   │   └── vscodeTypes.ts       # VS Code 扩展类型
│   ├── utils/                   # 工具类
│   │   ├── logger.ts            # 日志管理
│   │   ├── apiKeyManager.ts     # API密钥管理
│   │   ├── configManager.ts     # 配置管理
│   │   └── openaiHandler.ts     # OpenAI兼容处理器
│   ├── base/                    # 基础实现
│   │   ├── baseProvider.ts      # 供应商基类
│   │   └── baseTool.ts          # 工具基类
│   └── index.ts                 # 导出文件
├── package.json
└── tsconfig.json
```

#### 核心接口

```typescript
// src/interfaces/provider.ts
export interface IGCMPProvider {
    readonly providerKey: string;
    readonly displayName: string;
    readonly config: ProviderConfig;
    readonly version: string;

    activate(context: vscode.ExtensionContext): Promise<void>;
    deactivate(): Promise<void>;
    getModels(): ModelConfig[];
    createChatProvider(modelId: string): vscode.LanguageModelChatProvider;
    getTools(): ITool[];
}

// src/interfaces/config.ts
export interface IGCMPCoreAPI {
    // 供应商管理
    registerProvider(provider: IGCMPProvider): void;
    unregisterProvider(providerKey: string): void;
    getProvider(providerKey: string): IGCMPProvider | undefined;
    getAllProviders(): IGCMPProvider[];

    // 工具注册
    registerTool(tool: ITool): void;
    getTools(): ITool[];

    // 配置管理
    getGlobalConfig(): GCMPConfig;
    updateGlobalConfig(config: Partial<GCMPConfig>): void;

    // 事件系统
    onProviderRegistered: vscode.Event<IGCMPProvider>;
    onProviderUnregistered: vscode.Event<string>;
    onConfigChanged: vscode.Event<GCMPConfig>;
}
```

### 供应商扩展包设计

每个供应商扩展包遵循统一的结构：

#### 目录结构

```
packages/provider-{name}/
├── src/
│   ├── config/
│   │   └── provider.json        # 供应商配置
│   ├── provider/
│   │   ├── {name}Provider.ts    # 供应商实现
│   │   └── index.ts
│   ├── tools/                   # 供应商特定工具（可选）
│   │   └── {toolName}.ts
│   ├── extension.ts             # 扩展入口
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

#### 扩展入口示例

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { IGCMPProvider, IGCMPCoreAPI } from '@gcmp/core';
import { ZhipuProvider } from './provider';

let provider: ZhipuProvider;

export async function activate(context: vscode.ExtensionContext) {
    // 获取核心API
    const coreAPI = await getCoreAPI();
    if (!coreAPI) {
        throw new Error('GCMP Core not found');
    }

    // 创建并注册供应商
    provider = new ZhipuProvider();
    await provider.activate(context);
    coreAPI.registerProvider(provider);
}

export async function deactivate() {
    if (provider) {
        await provider.deactivate();
    }
}

async function getCoreAPI(): Promise<IGCMPCoreAPI | undefined> {
    const extension = vscode.extensions.getExtension('@gcmp/integration');
    if (!extension) {
        return undefined;
    }

    if (!extension.isActive) {
        await extension.activate();
    }

    return extension.exports as IGCMPCoreAPI;
}
```

### 集成包设计

统一集成包负责协调所有供应商扩展：

#### 目录结构

```
packages/integration/
├── src/
│   ├── core/
│   │   ├── extensionLoader.ts   # 扩展加载器
│   │   ├── providerRegistry.ts  # 供应商注册表
│   │   └── configManager.ts     # 统一配置管理
│   ├── ui/
│   │   ├── modelSelector.ts     # 模型选择器
│   │   └── settingsView.ts      # 设置视图
│   ├── extension.ts             # 集成包入口
│   └── index.ts
├── resources/                   # 资源文件
├── package.json
└── tsconfig.json
```

## 动态加载机制

### 扩展发现

```typescript
// src/core/extensionLoader.ts
export class ExtensionLoader {
    private discoveredProviders = new Map<string, IGCMPProvider>();
    private readonly extensionPattern = /^@gcmp\/provider-/;

    async discoverAndLoadProviders(): Promise<void> {
        const extensions = vscode.extensions.all.filter(ext => this.extensionPattern.test(ext.id));

        for (const extension of extensions) {
            try {
                await this.loadProvider(extension);
            } catch (error) {
                Logger.error(`Failed to load provider ${extension.id}:`, error);
            }
        }
    }

    private async loadProvider(extension: vscode.Extension<any>): Promise<void> {
        if (!extension.isActive) {
            await extension.activate();
        }

        // 验证扩展导出的API
        const api = extension.exports as IGCMPProvider;
        if (this.validateProviderAPI(api)) {
            this.discoveredProviders.set(api.providerKey, api);
            Logger.info(`Provider ${api.displayName} loaded successfully`);
        } else {
            throw new Error(`Invalid provider API for ${extension.id}`);
        }
    }

    private validateProviderAPI(api: any): api is IGCMPProvider {
        return (
            api &&
            typeof api.providerKey === 'string' &&
            typeof api.displayName === 'string' &&
            typeof api.activate === 'function' &&
            typeof api.deactivate === 'function' &&
            typeof api.getModels === 'function' &&
            typeof api.createChatProvider === 'function'
        );
    }
}
```

### 依赖管理

```typescript
// src/core/dependencyManager.ts
export class DependencyManager {
    private dependencyGraph = new Map<string, Set<string>>();

    registerDependency(provider: string, dependency: string): void {
        if (!this.dependencyGraph.has(provider)) {
            this.dependencyGraph.set(provider, new Set());
        }
        this.dependencyGraph.get(provider)!.add(dependency);
    }

    getLoadOrder(providers: string[]): string[] {
        // 拓扑排序确定加载顺序
        return this.topologicalSort(providers);
    }

    private topologicalSort(nodes: string[]): string[] {
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const result: string[] = [];

        const visit = (node: string) => {
            if (visiting.has(node)) {
                throw new Error(`Circular dependency detected: ${node}`);
            }
            if (visited.has(node)) {
                return;
            }

            visiting.add(node);
            const dependencies = this.dependencyGraph.get(node) || new Set();
            for (const dep of dependencies) {
                visit(dep);
            }
            visiting.delete(node);
            visited.add(node);
            result.push(node);
        };

        for (const node of nodes) {
            visit(node);
        }

        return result;
    }
}
```

## 配置管理

### 分层配置系统

```typescript
// src/core/configManager.ts
export class HierarchicalConfigManager {
    private globalConfig: GCMPConfig;
    private providerConfigs = new Map<string, any>();

    getProviderConfig(providerKey: string): any {
        // 合并全局配置和供应商特定配置
        const global = this.globalConfig;
        const provider = this.providerConfigs.get(providerKey) || {};

        return {
            ...global,
            ...provider
        };
    }

    updateProviderConfig(providerKey: string, config: any): void {
        this.providerConfigs.set(providerKey, config);
        this.notifyConfigChange(providerKey);
    }

    private notifyConfigChange(providerKey: string): void {
        // 通知相关供应商配置已更改
        const provider = this.providerRegistry.getProvider(providerKey);
        if (provider && typeof provider.onConfigChanged === 'function') {
            provider.onConfigChanged(this.getProviderConfig(providerKey));
        }
    }
}
```

## 迁移策略

### 阶段1：核心包提取

1. 创建 `@gcmp/core` 包
2. 提取共享类型和工具类
3. 定义核心接口
4. 建立基础测试框架

### 阶段2：供应商拆分

1. 选择2-3个代表性供应商进行试点
2. 创建独立的供应商扩展包
3. 实现动态加载机制
4. 验证功能完整性

### 阶段3：全面迁移

1. 逐个迁移剩余供应商
2. 完善集成包功能
3. 更新构建和发布流程
4. 完善文档和测试

### 阶段4：优化和发布

1. 性能优化
2. 用户体验优化
3. 正式发布新架构
4. 旧版本兼容性处理

## 向后兼容性

### 用户体验保持

- 统一的模型选择器
- 一致的配置界面
- 无缝的更新体验

### API兼容性

- 保持现有命令ID
- 维护配置格式
- 支持渐进式迁移

## 构建和发布

### Monorepo管理

使用 Lerna 或 Rush 管理 monorepo：

```json
{
    "scripts": {
        "build": "lerna run build",
        "test": "lerna run test",
        "publish": "lerna publish",
        "bootstrap": "lerna bootstrap"
    }
}
```

### CI/CD流程

1. 自动化测试
2. 版本管理
3. 独立发布
4. 依赖检查

## 总结

这个模块化架构设计提供了：

- **清晰的职责分离**：核心包提供基础功能，供应商包专注特定实现
- **灵活的扩展机制**：便于添加新供应商和功能
- **良好的用户体验**：保持统一的使用体验
- **可维护性**：降低代码复杂度，便于维护和更新

通过这种设计，GCMP 将从一个单体扩展演进为一个健康的生态系统，既保持了现有功能，又为未来发展奠定了坚实基础。
