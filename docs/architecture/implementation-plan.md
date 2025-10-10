# GCMP 模块化实施计划

## 实施概览

本文档详细描述了 GCMP 从单体架构向模块化生态系统转型的具体实施步骤。

## 阶段划分

### 阶段 1：基础设施准备 (1-2周)

#### 1.1 创建 Monorepo 结构

```bash
# 创建新的包结构
mkdir -p packages/{core,provider-zhipu,provider-iflow,integration}
mkdir -p tools/{build,scripts}
mkdir -p docs/{api,guides}
```

#### 1.2 配置 Lerna 管理

```json
// lerna.json
{
    "version": "independent",
    "npmClient": "npm",
    "command": {
        "publish": {
            "conventionalCommits": true,
            "message": "chore(release): publish",
            "registry": "https://registry.npmjs.org/"
        },
        "bootstrap": {
            "ignore": "component-*",
            "npmClientArgs": ["--no-package-lock"]
        }
    },
    "packages": ["packages/*"]
}
```

#### 1.3 核心包初始化

```json
// packages/core/package.json
{
    "name": "@gcmp/core",
    "version": "1.0.0",
    "description": "GCMP Core - Shared functionality for all providers",
    "main": "out/index.js",
    "types": "out/index.d.ts",
    "scripts": {
        "build": "tsc",
        "test": "jest",
        "lint": "eslint src --ext .ts"
    },
    "dependencies": {
        "@microsoft/tiktokenizer": "^1.0.0",
        "vscode": "^1.85.0"
    },
    "devDependencies": {
        "@types/vscode": "^1.85.0",
        "typescript": "^5.0.0"
    },
    "peerDependencies": {
        "vscode": "^1.85.0"
    }
}
```

### 阶段 2：核心包开发 (2-3周)

#### 2.1 提取共享类型定义

```typescript
// packages/core/src/types/sharedTypes.ts
export interface ModelConfig {
    id: string;
    name: string;
    tooltip: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    version?: string;
    capabilities: {
        toolCalling: boolean;
        imageInput: boolean;
    };
    baseUrl?: string;
    model?: string;
}

export interface ProviderConfig {
    displayName: string;
    baseUrl: string;
    apiKeyTemplate: string;
    models: ModelConfig[];
    customHeaders?: Record<string, string>;
    dependencies?: string[]; // 依赖的其他供应商
}

export interface GCMPConfig {
    temperature: number;
    topP: number;
    maxTokens: number;
    zhipu: {
        search: {
            enableMCP: boolean;
        };
    };
}
```

#### 2.2 定义核心接口

```typescript
// packages/core/src/interfaces/provider.ts
import * as vscode from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';

export interface IGCMPProvider {
    readonly providerKey: string;
    readonly displayName: string;
    readonly config: ProviderConfig;
    readonly version: string;

    // 生命周期
    activate(context: vscode.ExtensionContext): Promise<void>;
    deactivate(): Promise<void>;

    // 模型管理
    getModels(): ModelConfig[];
    createChatProvider(modelId: string): vscode.LanguageModelChatProvider;

    // 工具支持
    getTools(): ITool[];

    // 配置变更
    onConfigChanged?(config: any): void;
}

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

#### 2.3 实现基础工具类

```typescript
// packages/core/src/utils/logger.ts
export class Logger {
    private static outputChannel: vscode.OutputChannel;
    private static logLevel: LogLevel = LogLevel.Info;

    static initialize(name: string): void {
        this.outputChannel = vscode.window.createOutputChannel(name);
    }

    static info(message: string, ...args: any[]): void {
        this.log(LogLevel.Info, message, ...args);
    }

    static error(message: string, ...args: any[]): void {
        this.log(LogLevel.Error, message, ...args);
    }

    private static log(level: LogLevel, message: string, ...args: any[]): void {
        if (level >= this.logLevel) {
            const timestamp = new Date().toISOString();
            const logMessage = `[${timestamp}] [${LogLevel[level]}] ${message}`;

            this.outputChannel.appendLine(logMessage);
            if (args.length > 0) {
                this.outputChannel.appendLine(JSON.stringify(args, null, 2));
            }
        }
    }
}
```

#### 2.4 实现供应商基类

```typescript
// packages/core/src/base/baseProvider.ts
import * as vscode from 'vscode';
import { IGCMPProvider } from '../interfaces/provider';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager, OpenAIHandler } from '../utils';

export abstract class BaseModelProvider implements IGCMPProvider {
    protected openaiHandler: OpenAIHandler;
    protected apiKeyManager: ApiKeyManager;

    constructor(
        public readonly providerKey: string,
        public readonly displayName: string,
        public readonly config: ProviderConfig,
        public readonly version: string = '1.0.0'
    ) {
        this.openaiHandler = new OpenAIHandler(providerKey, displayName, config.baseUrl);
        this.apiKeyManager = new ApiKeyManager(providerKey, displayName);
    }

    async activate(context: vscode.ExtensionContext): Promise<void> {
        Logger.info(`Activating provider: ${this.displayName}`);

        // 注册命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${this.providerKey}.setApiKey`, () =>
            this.apiKeyManager.promptAndSetApiKey()
        );

        context.subscriptions.push(setApiKeyCommand);

        // 子类特定的激活逻辑
        await this.onActivate(context);
    }

    async deactivate(): Promise<void> {
        Logger.info(`Deactivating provider: ${this.displayName}`);
        await this.onDeactivate();
    }

    getModels(): ModelConfig[] {
        return this.config.models;
    }

    createChatProvider(modelId: string): vscode.LanguageModelChatProvider {
        return this.createChatProviderInternal(modelId);
    }

    getTools(): ITool[] {
        return this.getToolsInternal();
    }

    // 抽象方法，由子类实现
    protected abstract createChatProviderInternal(modelId: string): vscode.LanguageModelChatProvider;
    protected abstract getToolsInternal(): ITool[];
    protected async onActivate(context: vscode.ExtensionContext): Promise<void> {}
    protected async onDeactivate(): Promise<void> {}
}
```

### 阶段 3：试点供应商迁移 (2-3周)

#### 3.1 选择试点供应商

选择智谱AI (zhipu) 和心流AI (iflow) 作为试点，因为：

- 智谱AI：使用通用Provider，代表标准OpenAI兼容供应商
- 心流AI：有特殊实现，代表需要自定义逻辑的供应商

#### 3.2 创建智谱AI扩展包

```typescript
// packages/provider-zhipu/src/extension.ts
import * as vscode from 'vscode';
import { ZhipuProvider } from './provider';
import { getCoreAPI } from '@gcmp/core';

let provider: ZhipuProvider;

export async function activate(context: vscode.ExtensionContext) {
    const coreAPI = await getCoreAPI();
    if (!coreAPI) {
        throw new Error('GCMP Core not found');
    }

    provider = new ZhipuProvider();
    await provider.activate(context);
    coreAPI.registerProvider(provider);
}

export async function deactivate() {
    if (provider) {
        await provider.deactivate();
    }
}
```

```typescript
// packages/provider-zhipu/src/provider/zhipuProvider.ts
import { BaseModelProvider } from '@gcmp/core';
import { GenericChatProvider } from './genericChatProvider';
import { ZhipuSearchTool } from './tools/zhipuSearchTool';

export class ZhipuProvider extends BaseModelProvider {
    constructor() {
        const config = require('../config/provider.json');
        super('zhipu', '智谱AI', config);
    }

    protected createChatProviderInternal(modelId: string) {
        return new GenericChatProvider(this.providerKey, this.displayName, this.config, modelId);
    }

    protected getToolsInternal() {
        return [new ZhipuSearchTool()];
    }
}
```

#### 3.3 创建心流AI扩展包

```typescript
// packages/provider-iflow/src/provider/iflowProvider.ts
import { BaseModelProvider } from '@gcmp/core';
import { IFlowChatProvider } from './iflowChatProvider';

export class IFlowProvider extends BaseModelProvider {
    constructor() {
        const config = require('../config/provider.json');
        super('iflow', '心流AI', config);
    }

    protected createChatProviderInternal(modelId: string) {
        return new IFlowChatProvider(this.providerKey, this.displayName, this.config, modelId);
    }

    protected getToolsInternal() {
        return []; // 心流AI暂无特殊工具
    }
}
```

### 阶段 4：集成包开发 (2-3周)

#### 4.1 扩展加载器实现

```typescript
// packages/integration/src/core/extensionLoader.ts
import * as vscode from 'vscode';
import { IGCMPProvider, IGCMPCoreAPI } from '@gcmp/core';
import { Logger } from '@gcmp/core';

export class ExtensionLoader {
    private discoveredProviders = new Map<string, IGCMPProvider>();
    private readonly extensionPattern = /^@gcmp\/provider-/;

    async discoverAndLoadProviders(): Promise<IGCMPProvider[]> {
        Logger.info('Discovering GCMP provider extensions...');

        const extensions = vscode.extensions.all.filter(ext => this.extensionPattern.test(ext.id));

        Logger.info(`Found ${extensions.length} provider extensions`);

        for (const extension of extensions) {
            try {
                await this.loadProvider(extension);
            } catch (error) {
                Logger.error(`Failed to load provider ${extension.id}:`, error);
            }
        }

        return Array.from(this.discoveredProviders.values());
    }

    private async loadProvider(extension: vscode.Extension<any>): Promise<void> {
        Logger.info(`Loading provider: ${extension.id}`);

        if (!extension.isActive) {
            await extension.activate();
        }

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

#### 4.2 集成包主入口

```typescript
// packages/integration/src/extension.ts
import * as vscode from 'vscode';
import { ExtensionLoader } from './core/extensionLoader';
import { ProviderRegistry } from './core/providerRegistry';
import { Logger } from '@gcmp/core';

let extensionLoader: ExtensionLoader;
let providerRegistry: ProviderRegistry;

export async function activate(context: vscode.ExtensionContext) {
    Logger.initialize('GCMP Integration');
    Logger.info('Activating GCMP Integration...');

    // 初始化核心组件
    extensionLoader = new ExtensionLoader();
    providerRegistry = new ProviderRegistry();

    // 发现并加载供应商扩展
    const providers = await extensionLoader.discoverAndLoadProviders();

    // 注册所有供应商
    for (const provider of providers) {
        providerRegistry.registerProvider(provider);
    }

    // 注册VS Code贡献点
    registerVSCodeContributions(context, providerRegistry);

    Logger.info(`GCMP Integration activated with ${providers.length} providers`);
}

export async function deactivate() {
    Logger.info('Deactivating GCMP Integration...');

    if (providerRegistry) {
        await providerRegistry.deactivateAll();
    }

    Logger.info('GCMP Integration deactivated');
}

function registerVSCodeContributions(context: vscode.ExtensionContext, registry: ProviderRegistry) {
    // 注册所有供应商的模型
    for (const provider of registry.getAllProviders()) {
        for (const model of provider.getModels()) {
            const disposable = vscode.chat.registerChatModelProvider(
                `gcmp.${provider.providerKey}.${model.id}`,
                provider.createChatProvider(model.id)
            );
            context.subscriptions.push(disposable);
        }
    }
}
```

### 阶段 5：全面迁移 (3-4周)

#### 5.1 批量迁移脚本

```typescript
// tools/scripts/migrate-provider.ts
import * as fs from 'fs';
import * as path from 'path';

interface ProviderConfig {
    key: string;
    displayName: string;
    hasCustomProvider: boolean;
    hasTools: boolean;
}

const providers: ProviderConfig[] = [
    { key: 'moonshot', displayName: 'MoonshotAI', hasCustomProvider: false, hasTools: false },
    { key: 'deepseek', displayName: 'DeepSeek', hasCustomProvider: false, hasTools: false },
    { key: 'volcengine', displayName: '火山方舟', hasCustomProvider: false, hasTools: false }
    // ... 其他供应商
];

async function migrateProvider(provider: ProviderConfig): Promise<void> {
    console.log(`Migrating provider: ${provider.key}`);

    // 创建目录结构
    const packageDir = `packages/provider-${provider.key}`;
    fs.mkdirSync(path.join(packageDir, 'src/config'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'src/provider'), { recursive: true });

    // 复制配置文件
    const configSource = `src/providers/config/${provider.key}.json`;
    const configDest = `${packageDir}/src/config/provider.json`;
    if (fs.existsSync(configSource)) {
        fs.copyFileSync(configSource, configDest);
    }

    // 生成package.json
    generatePackageJson(provider, packageDir);

    // 生成provider实现
    generateProviderImplementation(provider, packageDir);

    // 生成extension.ts
    generateExtensionEntry(provider, packageDir);

    console.log(`Provider ${provider.key} migrated successfully`);
}

function generatePackageJson(provider: ProviderConfig, packageDir: string): void {
    const packageJson = {
        name: `@gcmp/provider-${provider.key}`,
        version: '1.0.0',
        description: `GCMP Provider - ${provider.displayName}`,
        main: 'out/extension.js',
        types: 'out/extension.d.ts',
        scripts: {
            build: 'tsc',
            test: 'jest',
            lint: 'eslint src --ext .ts'
        },
        dependencies: {
            '@gcmp/core': '^1.0.0'
        },
        devDependencies: {
            '@types/vscode': '^1.85.0',
            typescript: '^5.0.0'
        },
        peerDependencies: {
            vscode: '^1.85.0'
        },
        activationEvents: [`onLanguageModelProvider:gcmp.${provider.key}`],
        contributes: {
            commands: [
                {
                    command: `gcmp.${provider.key}.setApiKey`,
                    title: `Set ${provider.displayName} API Key`
                }
            ],
            languageModelChatProviders: [
                {
                    id: `gcmp.${provider.key}`,
                    name: provider.displayName,
                    vendor: provider.key
                }
            ]
        }
    };

    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));
}
```

#### 5.2 迁移执行

```bash
# 执行批量迁移
npm run migrate:providers

# 验证迁移结果
npm run validate:migration

# 构建所有包
npm run build:all
```

### 阶段 6：测试和优化 (2-3周)

#### 6.1 集成测试

```typescript
// packages/integration/test/integration.test.ts
import * as vscode from 'vscode';
import { ExtensionLoader } from '../src/core/extensionLoader';

suite('GCMP Integration Tests', () => {
    test('should load all provider extensions', async () => {
        const loader = new ExtensionLoader();
        const providers = await loader.discoverAndLoadProviders();

        assert(providers.length > 0, 'Should load at least one provider');

        for (const provider of providers) {
            assert(provider.providerKey, 'Provider should have a key');
            assert(provider.displayName, 'Provider should have a display name');
            assert(provider.getModels().length > 0, 'Provider should have models');
        }
    });

    test('should register chat model providers', async () => {
        // 测试VS Code chat model provider注册
        const providers = await vscode.chat.getChatModelProviders();
        const gcmpProviders = Object.keys(providers).filter(id => id.startsWith('gcmp.'));

        assert(gcmpProviders.length > 0, 'Should register GCMP providers');
    });
});
```

#### 6.2 性能优化

```typescript
// packages/core/src/utils/lazyLoader.ts
export class LazyLoader<T> {
    private factory: () => Promise<T>;
    private instance: T | null = null;
    private loading: Promise<T> | null = null;

    constructor(factory: () => Promise<T>) {
        this.factory = factory;
    }

    async load(): Promise<T> {
        if (this.instance) {
            return this.instance;
        }

        if (this.loading) {
            return this.loading;
        }

        this.loading = this.factory();
        this.instance = await this.loading;
        this.loading = null;

        return this.instance;
    }
}

// 使用示例
const providerLoader = new LazyLoader(async () => {
    const extension = vscode.extensions.getExtension('@gcmp/provider-zhipu');
    if (!extension) {
        throw new Error('Zhipu provider not found');
    }
    await extension.activate();
    return extension.exports;
});
```

### 阶段 7：发布准备 (1-2周)

#### 7.1 版本管理策略

```json
{
    "scripts": {
        "version:core": "lerna version --scope @gcmp/core",
        "version:providers": "lerna version --scope '@gcmp/provider-*'",
        "version:integration": "lerna version --scope @gcmp/integration",
        "version:all": "lerna version"
    }
}
```

#### 7.2 发布流程

```bash
# 1. 更新版本
npm run version:all

# 2. 构建所有包
npm run build:all

# 3. 运行测试
npm run test:all

# 4. 发布到npm
npm run publish:all

# 5. 更新VS Code市场
npm run publish:vscode
```

## 风险控制

### 技术风险

1. **依赖冲突**：通过严格的版本管理和测试避免
2. **性能问题**：实现懒加载和缓存机制
3. **兼容性问题**：保持API向后兼容，提供迁移工具

### 用户体验风险

1. **功能缺失**：通过全面的集成测试确保功能完整
2. **配置丢失**：提供配置迁移工具
3. **学习成本**：保持界面一致性，提供详细文档

### 发布风险

1. **版本混乱**：使用语义化版本和自动化发布
2. **回滚困难**：保留旧版本，提供回滚机制

## 成功指标

### 技术指标

- [ ] 所有供应商成功迁移到独立包
- [ ] 集成测试覆盖率 > 90%
- [ ] 构建时间 < 5分钟
- [ ] 扩展启动时间 < 2秒

### 用户体验指标

- [ ] 保持现有功能完整性
- [ ] 用户配置无缝迁移
- [ ] 支持按需安装供应商
- [ ] 统一的配置和管理界面

### 开发效率指标

- [ ] 新供应商开发时间减少50%
- [ ] 代码复用率 > 80%
- [ ] 独立发布周期 < 1天
- [ ] 文档覆盖率100%

通过这个详细的实施计划，GCMP将成功转型为一个模块化、可扩展的生态系统，为用户提供更好的体验，为开发者提供更高效的开发流程。
