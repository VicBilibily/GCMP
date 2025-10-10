# GCMP 模块化改造快速开始指南

## 概述

本指南提供开始 GCMP 模块化改造的具体步骤和代码示例。

## 第一步：创建 Monorepo 基础结构

### 1.1 初始化 Lerna 配置

```bash
# 安装 lerna
npm install -g lerna

# 初始化 lerna
lerna init
```

### 1.2 创建根目录配置文件

#### package.json

```json
{
    "name": "gcmp-ecosystem",
    "private": true,
    "workspaces": ["packages/*"],
    "scripts": {
        "bootstrap": "lerna bootstrap",
        "build": "lerna run build",
        "test": "lerna run test",
        "lint": "lerna run lint",
        "clean": "lerna clean && rimraf packages/*/out",
        "version": "lerna version",
        "publish": "lerna publish",
        "dev": "lerna run dev --parallel",
        "create:provider": "node tools/scripts/create-provider.js"
    },
    "devDependencies": {
        "lerna": "^8.0.0",
        "rimraf": "^5.0.0",
        "typescript": "^5.0.0"
    }
}
```

#### lerna.json

```json
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

## 第二步：创建核心包 (@gcmp/core)

### 2.1 创建目录结构

```bash
mkdir -p packages/core/src/{interfaces,types,utils,base}
mkdir -p packages/core/test
```

### 2.2 核心包 package.json

```json
{
    "name": "@gcmp/core",
    "version": "1.0.0",
    "description": "GCMP Core - Shared functionality for all providers",
    "main": "out/index.js",
    "types": "out/index.d.ts",
    "scripts": {
        "build": "tsc",
        "test": "jest",
        "lint": "eslint src --ext .ts",
        "dev": "tsc --watch"
    },
    "dependencies": {
        "@microsoft/tiktokenizer": "^1.0.0"
    },
    "devDependencies": {
        "@types/vscode": "^1.85.0",
        "@types/jest": "^29.0.0",
        "jest": "^29.0.0",
        "ts-jest": "^29.0.0",
        "typescript": "^5.0.0"
    },
    "peerDependencies": {
        "vscode": "^1.85.0"
    },
    "files": ["out/**/*"]
}
```

### 2.3 核心接口定义

```typescript
// packages/core/src/interfaces/provider.ts
import * as vscode from 'vscode';
import { ProviderConfig, ModelConfig, GCMPConfig } from '../types/sharedTypes';

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

export interface ITool {
    readonly id: string;
    readonly name: string;
    readonly description: string;

    execute(input: any): Promise<any>;
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

### 2.4 基础Provider类

```typescript
// packages/core/src/base/baseProvider.ts
import * as vscode from 'vscode';
import { IGCMPProvider, ITool } from '../interfaces/provider';
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

        // 注册设置API密钥命令
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

## 第三步：创建第一个供应商扩展（智谱AI）

### 3.1 创建目录结构

```bash
mkdir -p packages/provider-zhipu/src/{config,provider,tools}
```

### 3.2 供应商配置

```json
// packages/provider-zhipu/src/config/provider.json
{
    "displayName": "智谱AI",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyTemplate": "sk-{apiKey}",
    "models": [
        {
            "id": "glm-4",
            "name": "GLM-4",
            "tooltip": "智谱AI GLM-4 模型",
            "maxInputTokens": 128000,
            "maxOutputTokens": 8192,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
            }
        },
        {
            "id": "glm-4-flash",
            "name": "GLM-4-Flash",
            "tooltip": "智谱AI GLM-4-Flash 快速模型",
            "maxInputTokens": 128000,
            "maxOutputTokens": 8192,
            "capabilities": {
                "toolCalling": true,
                "imageInput": false
            }
        }
    ]
}
```

### 3.3 供应商实现

```typescript
// packages/provider-zhipu/src/provider/zhipuProvider.ts
import { BaseModelProvider } from '@gcmp/core';
import { GenericChatProvider } from './genericChatProvider';
import { ZhipuSearchTool } from '../tools/zhipuSearchTool';

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

### 3.4 扩展入口

```typescript
// packages/provider-zhipu/src/extension.ts
import * as vscode from 'vscode';
import { ZhipuProvider } from './provider/zhipuProvider';
import { getCoreAPI } from '@gcmp/core';

let provider: ZhipuProvider;

export async function activate(context: vscode.ExtensionContext) {
    try {
        const coreAPI = await getCoreAPI();
        if (!coreAPI) {
            throw new Error('GCMP Core not found');
        }

        provider = new ZhipuProvider();
        await provider.activate(context);
        coreAPI.registerProvider(provider);

        vscode.window.showInformationMessage('智谱AI 供应商已激活');
    } catch (error) {
        vscode.window.showErrorMessage(`激活智谱AI失败: ${error.message}`);
        throw error;
    }
}

export async function deactivate() {
    if (provider) {
        await provider.deactivate();
    }
}
```

### 3.5 供应商 package.json

```json
{
    "name": "@gcmp/provider-zhipu",
    "version": "1.0.0",
    "description": "GCMP Provider - 智谱AI",
    "main": "out/extension.js",
    "types": "out/extension.d.ts",
    "scripts": {
        "build": "tsc",
        "test": "jest",
        "lint": "eslint src --ext .ts",
        "dev": "tsc --watch"
    },
    "dependencies": {
        "@gcmp/core": "^1.0.0"
    },
    "devDependencies": {
        "@types/vscode": "^1.85.0",
        "typescript": "^5.0.0"
    },
    "peerDependencies": {
        "vscode": "^1.85.0"
    },
    "engines": {
        "vscode": "^1.85.0"
    },
    "activationEvents": ["onLanguageModelProvider:gcmp.zhipu"],
    "contributes": {
        "commands": [
            {
                "command": "gcmp.zhipu.setApiKey",
                "title": "设置智谱AI API密钥",
                "category": "GCMP"
            }
        ],
        "languageModelChatProviders": [
            {
                "id": "gcmp.zhipu",
                "name": "智谱AI",
                "vendor": "zhipu"
            }
        ]
    },
    "files": ["out/**/*"]
}
```

## 第四步：创建集成包

### 4.1 创建目录结构

```bash
mkdir -p packages/integration/src/{core,ui}
```

### 4.2 扩展加载器

```typescript
// packages/integration/src/core/extensionLoader.ts
import * as vscode from 'vscode';
import { IGCMPProvider } from '@gcmp/core';
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

### 4.3 集成包主入口

```typescript
// packages/integration/src/extension.ts
import * as vscode from 'vscode';
import { ExtensionLoader } from './core/extensionLoader';
import { ProviderRegistry } from './core/providerRegistry';
import { Logger, initializeCoreAPI } from '@gcmp/core';

let extensionLoader: ExtensionLoader;
let providerRegistry: ProviderRegistry;

export async function activate(context: vscode.ExtensionContext) {
    Logger.initialize('GCMP Integration');
    Logger.info('Activating GCMP Integration...');

    try {
        // 初始化核心API
        const coreAPI = initializeCoreAPI();

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

        if (providers.length === 0) {
            const installProviders = '安装供应商扩展';
            const result = await vscode.window.showInformationMessage(
                '未发现任何供应商扩展，请安装所需的AI供应商扩展',
                installProviders
            );

            if (result === installProviders) {
                vscode.env.openExternal(vscode.Uri.parse('vscode:extension/@gcmp/provider-zhipu'));
            }
        }
    } catch (error) {
        Logger.error('Failed to activate GCMP Integration:', error);
        vscode.window.showErrorMessage(`GCMP集成激活失败: ${error.message}`);
    }
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

## 第五步：开发工具和脚本

### 5.1 供应商创建脚本

```javascript
// tools/scripts/create-provider.js
const fs = require('fs');
const path = require('path');

const providerName = process.argv[2];
if (!providerName) {
    console.error('Please provide a provider name');
    process.exit(1);
}

const packageDir = `packages/provider-${providerName}`;

// 创建目录结构
fs.mkdirSync(path.join(packageDir, 'src/config'), { recursive: true });
fs.mkdirSync(path.join(packageDir, 'src/provider'), { recursive: true });

// 生成package.json
const packageJson = {
    name: `@gcmp/provider-${providerName}`,
    version: '1.0.0',
    description: `GCMP Provider - ${providerName}`,
    main: 'out/extension.js',
    types: 'out/extension.d.ts',
    scripts: {
        build: 'tsc',
        test: 'jest',
        lint: 'eslint src --ext .ts',
        dev: 'tsc --watch'
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
    engines: {
        vscode: '^1.85.0'
    },
    activationEvents: [`onLanguageModelProvider:gcmp.${providerName}`],
    contributes: {
        commands: [
            {
                command: `gcmp.${providerName}.setApiKey`,
                title: `设置 ${providerName} API密钥`,
                category: 'GCMP'
            }
        ],
        languageModelChatProviders: [
            {
                id: `gcmp.${providerName}`,
                name: providerName,
                vendor: providerName
            }
        ]
    },
    files: ['out/**/*']
};

fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));

// 生成基础文件
const extensionTs = `import * as vscode from 'vscode';
import { ${providerName.charAt(0).toUpperCase() + providerName.slice(1)}Provider } from './provider/${providerName}Provider';
import { getCoreAPI } from '@gcmp/core';

let provider: ${providerName.charAt(0).toUpperCase() + providerName.slice(1)}Provider;

export async function activate(context: vscode.ExtensionContext) {
  try {
    const coreAPI = await getCoreAPI();
    if (!coreAPI) {
      throw new Error('GCMP Core not found');
    }
    
    provider = new ${providerName.charAt(0).toUpperCase() + providerName.slice(1)}Provider();
    await provider.activate(context);
    coreAPI.registerProvider(provider);
    
    vscode.window.showInformationMessage('${providerName} 供应商已激活');
  } catch (error) {
    vscode.window.showErrorMessage(\`激活${providerName}失败: \${error.message}\`);
    throw error;
  }
}

export async function deactivate() {
  if (provider) {
    await provider.deactivate();
  }
}
`;

fs.writeFileSync(path.join(packageDir, 'src/extension.ts'), extensionTs);

console.log(`Provider ${providerName} created successfully!`);
console.log(`Next steps:`);
console.log(`1. Edit ${packageDir}/src/config/provider.json`);
console.log(`2. Implement ${packageDir}/src/provider/${providerName}Provider.ts`);
console.log(`3. Run npm run bootstrap`);
console.log(`4. Run npm run build`);
```

### 5.2 TypeScript配置

```json
// packages/core/tsconfig.json
{
    "extends": "../../tsconfig.json",
    "compilerOptions": {
        "outDir": "./out",
        "rootDir": "./src",
        "declaration": true,
        "declarationMap": true,
        "sourceMap": true
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules", "out", "test"]
}
```

## 第六步：构建和测试

### 6.1 构建所有包

```bash
# 安装依赖
npm install

# Bootstrap所有包
npm run bootstrap

# 构建所有包
npm run build

# 运行测试
npm run test
```

### 6.2 本地测试

```bash
# 生成VSIX包
cd packages/integration
vsce package

# 安装到VS Code进行测试
code --install-extension gcmp-integration-*.vsix
```

## 下一步计划

1. **迁移现有供应商**：使用脚本批量迁移剩余的供应商
2. **完善测试**：添加单元测试和集成测试
3. **性能优化**：实现延迟加载和缓存机制
4. **文档完善**：编写详细的API文档和用户指南
5. **CI/CD设置**：配置自动化构建和发布流程

通过这个快速开始指南，你可以立即开始 GCMP 的模块化改造工作。建议先完成核心包和一个供应商扩展的完整实现，验证架构可行性后再进行大规模迁移。
