/*---------------------------------------------------------------------------------------------
 *  自定义模型管理器
 *  用于管理独立兼容提供商的自定义模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ProviderConfig, ProviderOverride } from '../types/sharedTypes';
import { StatusBarManager } from '../status';

/**
 * 后退按钮点击事件
 */
interface BackButtonClick {
    back: true;
}

/**
 * 判断是否为后退按钮点击
 */
function isBackButtonClick(value: unknown): value is BackButtonClick {
    return typeof value === 'object' && (value as BackButtonClick)?.back === true;
}

/**
 * 自定义模型配置接口
 */
export interface CompatibleModelConfig {
    /** 模型ID */
    id: string;
    /** 模型名称 */
    name: string;
    /** 提供商标识符 */
    provider: string;
    /** 模型描述 */
    tooltip?: string;
    /** API基础URL */
    baseUrl?: string;
    /** API请求时使用的模型名称（可选） */
    model?: string;
    /** 最大输入token数 */
    maxInputTokens: number;
    /** 最大输出token数 */
    maxOutputTokens: number;
    /** SDK模式 */
    sdkMode: 'openai' | 'anthropic';
    /** 模型能力 */
    capabilities: {
        /** 工具调用 */
        toolCalling: boolean;
        /** 图像输入 */
        imageInput: boolean;
    };
    /** 自定义HTTP头部（可选） */
    customHeader?: Record<string, string>;
    /** 额外的请求体参数（可选） */
    extraBody?: Record<string, unknown>;
    /** 是否启用输出思考过程（默认true，高级功能） */
    outputThinking?: boolean;
    /** 是否由向导创建（内部标记，不持久化） */
    _isFromWizard?: boolean;
}

/**
 * 自定义模型管理器类
 */
export class CompatibleModelManager {
    private static models: CompatibleModelConfig[] = [];
    private static configListener: vscode.Disposable | null = null;
    private static _onDidChangeModels = new vscode.EventEmitter<void>();
    static readonly onDidChangeModels = CompatibleModelManager._onDidChangeModels.event;

    public static readonly KnownProviders: Record<string, Partial<ProviderConfig & ProviderOverride>> = {
        aihubmix: {
            displayName: 'AIHubMix',
            customHeader: { 'APP-Code': 'TFUV4759' }
        },
        aiping: { displayName: 'AI Ping' },
        siliconflow: { displayName: '硅基流动' }
    };

    /**
     * 初始化模型管理器
     */
    static initialize(): void {
        this.loadModels();
        this.setupConfigListener();
        Logger.debug('自定义模型管理器已初始化');
    }

    /**
     * 清理资源
     */
    static dispose(): void {
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }
        this._onDidChangeModels.dispose();
        Logger.trace('自定义模型管理器已清理');
    }

    /**
     * 设置配置文件变化监听器
     */
    private static setupConfigListener(): void {
        // 清理旧的监听器
        if (this.configListener) {
            this.configListener.dispose();
        }
        // 监听 gcmp 配置变化
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('gcmp.compatibleModels')) {
                Logger.info('检测到自定义模型配置变化，正在重新加载...');
                this.loadModels();
                this._onDidChangeModels.fire();
            }
        });
    }

    /**
     * 从配置中加载模型
     */
    private static loadModels(): void {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            const modelsData = config.get<CompatibleModelConfig[]>('compatibleModels', []);
            this.models = (modelsData || []).map(model => {
                // 如果 tooltip 为空，根据模型配置生成默认 tooltip
                if (!model.tooltip) {
                    return {
                        ...model,
                        tooltip: `${model.name} (${model.sdkMode})`
                    };
                }
                return model;
            });
            Logger.debug(`已加载 ${this.models.length} 个自定义模型`);
        } catch (error) {
            Logger.error('加载自定义模型失败:', error);
            this.models = [];
        }
    }

    /**
     * 保存模型到配置
     */
    private static async saveModels(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            // 保存时移除 tooltip 字段，重新加载时会根据配置生成默认 tooltip
            const modelsToSave = this.models.map(model => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { _isFromWizard, tooltip, ...rest } = model;
                return rest;
            });
            await config.update('compatibleModels', modelsToSave, vscode.ConfigurationTarget.Global);
            Logger.debug('自定义模型已保存到配置');
        } catch (error) {
            Logger.error('保存自定义模型失败:', error);
            throw error;
        }
    }

    /**
     * 获取所有模型
     */
    static getModels(): CompatibleModelConfig[] {
        return this.models;
    }
    /**
     * 添加模型
     */
    static async addModel(model: CompatibleModelConfig): Promise<void> {
        // 检查模型ID是否已存在
        if (this.models.some(m => m.id === model.id)) {
            throw new Error(`模型 ID "${model.id}" 已存在`);
        }
        this.models.push(model);
        await this.saveModels();
        Logger.info(`已添加自定义模型: ${model.name} (${model.provider}, ${model.sdkMode})`);

        StatusBarManager.compatible?.checkAndShowStatus();
    }

    /**
     * 更新模型
     */
    static async updateModel(id: string, updates: Partial<CompatibleModelConfig>): Promise<void> {
        const index = this.models.findIndex(m => m.id === id);
        if (index === -1) {
            throw new Error(`未找到模型 ID "${id}"`);
        }
        this.models[index] = { ...this.models[index], ...updates };
        await this.saveModels();
        Logger.info(`已更新自定义模型: ${id}`);

        StatusBarManager.compatible?.checkAndShowStatus();
    }

    /**
     * 删除模型
     */
    static async removeModel(id: string): Promise<void> {
        const index = this.models.findIndex(m => m.id === id);
        if (index === -1) {
            throw new Error(`未找到模型 ID "${id}"`);
        }
        const removedModel = this.models[index];
        this.models.splice(index, 1);
        await this.saveModels();
        Logger.info(`已删除自定义模型: ${removedModel.name}`);

        await StatusBarManager.compatible?.checkAndShowStatus();
    }

    /**
     * 配置模型或更新 API 密钥（主入口）
     */
    static async configureModelOrUpdateAPIKey(): Promise<void> {
        // 如果没有自定义模型，直接进入新增流程
        if (this.models.length === 0) {
            Logger.info('没有自定义模型，直接进入新增流程');
            await this.configureModels();
            return;
        }

        interface BYOKQuickPickItem extends vscode.QuickPickItem {
            action: 'apiKey' | 'configureModels';
        }
        const options: BYOKQuickPickItem[] = [
            {
                label: '$(key) 管理 API 密钥',
                detail: '更新或配置提供商或模型的 API 密钥',
                action: 'apiKey'
            },
            {
                label: '$(settings-gear) 配置模型',
                detail: '添加、编辑或删除模型配置',
                action: 'configureModels'
            }
        ];

        const quickPick = vscode.window.createQuickPick<BYOKQuickPickItem>();
        quickPick.title = '管理 OpenAI / Anthropic Compatible 模型';
        quickPick.placeholder = '选择一个操作';
        quickPick.items = options;
        quickPick.ignoreFocusOut = true;

        const selected = await new Promise<BYOKQuickPickItem | undefined>(resolve => {
            quickPick.onDidAccept(() => {
                const selectedItem = quickPick.selectedItems[0];
                resolve(selectedItem);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve(undefined);
            });
            quickPick.show();
        });

        if (selected?.action === 'apiKey') {
            await this.promptAndSetApiKey();
        } else if (selected?.action === 'configureModels') {
            await this.configureModels();
        }
    }

    /**
     * 提示并设置 API 密钥 - 按提供商为单位设置
     */
    private static async promptAndSetApiKey(): Promise<void> {
        try {
            // 获取所有已配置的提供商
            const providers = await this.getUniqueProviders();
            if (providers.length === 0) {
                vscode.window.showWarningMessage('暂无自定义模型配置，请先添加模型');
                return;
            }
            // 如果只有一个提供商，直接设置该提供商的 API 密钥
            if (providers.length === 1) {
                await this.setApiKeyForProvider(providers[0]);
                return;
            }
            // 如果有多个提供商，让用户选择
            const selected = await vscode.window.showQuickPick(providers, {
                placeHolder: '选择要设置 API 密钥的提供商'
            });
            if (!selected) {
                return;
            }
            await this.setApiKeyForProvider(selected);
        } catch (error) {
            Logger.error('设置 API 密钥失败:', error);
            vscode.window.showErrorMessage(`设置 API 密钥失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 获取所有唯一的提供商列表
     */
    private static async getUniqueProviders(): Promise<string[]> {
        const providers = new Set<string>();
        // 从现有模型中获取所有提供商
        for (const model of this.models) {
            if (model.provider && model.provider.trim()) {
                providers.add(model.provider.trim());
            } else {
                // 如果模型没有指定提供商，使用 'compatible' 作为默认值
                providers.add('compatible');
            }
        }
        return Array.from(providers).sort();
    }

    /**
     * 为指定提供商设置 API 密钥
     */
    private static async setApiKeyForProvider(provider: string): Promise<void> {
        const apiKey = await vscode.window.showInputBox({
            prompt: `请输入 "${provider}" 的 API 密钥（留空则清除密钥）`,
            placeHolder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            password: true
        });
        if (apiKey === undefined) {
            return;
        }

        if (apiKey.trim().length === 0) {
            // 清空密钥
            await ApiKeyManager.deleteApiKey(provider);
            Logger.info(`提供商 "${provider}" 的 API 密钥已清除`);
        } else {
            // 保存密钥
            await ApiKeyManager.setApiKey(provider, apiKey.trim());
            Logger.info(`提供商 "${provider}" 的 API 密钥已设置`);
        }

        // 修改 API Key 后检查 Compatible 状态栏是否需要显示/隐藏
        await StatusBarManager.compatible?.checkAndShowStatus();
        await StatusBarManager.compatible?.delayedUpdate(provider, 0);
    } /**
     * 配置模型 - 主要配置流程
     */
    private static async configureModels(): Promise<void> {
        while (true) {
            interface ModelQuickPickItem extends vscode.QuickPickItem {
                modelId?: string;
                action?: 'add' | 'edit';
            }
            const items: ModelQuickPickItem[] = [];
            // 添加现有模型
            for (const model of this.models) {
                const details: string[] = [
                    `$(arrow-up) ${model.maxInputTokens} $(arrow-down) ${model.maxOutputTokens}`,
                    `$(chip) ${model.sdkMode === 'openai' ? 'OpenAI' : 'Anthropic'}`
                ];
                if (model.capabilities.toolCalling) {
                    details.push('$(plug) 工具调用');
                }
                if (model.capabilities.imageInput) {
                    details.push('$(circuit-board) 图像理解');
                }
                items.push({
                    label: model.name,
                    description: model.id,
                    detail: details.join('\t'),
                    modelId: model.id,
                    action: 'edit'
                });
            }
            // 如果没有模型且是首次调用
            if (items.length === 0) {
                const newModel = await this._configureModel('create');
                if (newModel) {
                    await this.addModel(newModel as CompatibleModelConfig);
                }
                return;
            }

            // 添加分隔符和操作
            if (items.length > 0) {
                const separator = { label: '', kind: vscode.QuickPickItemKind.Separator };
                items.push(separator as ModelQuickPickItem);
            }
            items.push({
                label: '$(add) 添加新模型',
                detail: '创建新的自定义模型配置',
                action: 'add'
            });

            const quickPick = vscode.window.createQuickPick<ModelQuickPickItem>();
            quickPick.title = '自定义模型配置';
            quickPick.placeholder = '选择一个模型进行编辑或添加新模型';
            quickPick.items = items;
            quickPick.ignoreFocusOut = true;

            const selected = await new Promise<ModelQuickPickItem | BackButtonClick | undefined>(resolve => {
                const disposables: vscode.Disposable[] = [];
                disposables.push(
                    quickPick.onDidAccept(() => {
                        const selectedItem = quickPick.selectedItems[0];
                        resolve(selectedItem);
                        quickPick.hide();
                    })
                );
                disposables.push(
                    quickPick.onDidHide(() => {
                        resolve(undefined);
                        disposables.forEach(d => d.dispose());
                    })
                );
                quickPick.show();
            });

            if (!selected || isBackButtonClick(selected)) {
                return;
            }

            if (selected.action === 'add') {
                const newModel = await this._configureModel('create');
                if (newModel) {
                    await this.addModel(newModel as CompatibleModelConfig);
                }
            } else if (selected.action === 'edit' && selected.modelId) {
                const model = this.models.find(m => m.id === selected.modelId);
                if (model) {
                    const result = await this._editModel(selected.modelId, model);
                    if (result) {
                        if (result.action === 'update' && result.config) {
                            await this.updateModel(result.id, result.config);
                        } else if (result.action === 'delete') {
                            await this.removeModel(result.id);
                        }
                    }
                }
            }
        }
    }

    /**
     * 配置模型的统一方法 - 处理添加和编辑流程
     * @param mode - 'create' 表示添加新模型，'edit' 表示编辑现有模型
     * @param currentConfig - 编辑模式下的当前模型配置
     */
    private static async _configureModel(
        mode: 'create' | 'edit',
        currentConfig?: CompatibleModelConfig
    ): Promise<CompatibleModelConfig | Partial<CompatibleModelConfig> | undefined> {
        // 第1步：模型唯一ID（仅在创建模式下需要）
        let modelId: string | undefined;
        if (mode === 'create') {
            const result = await this._createInputBoxWithBackButton({
                title: '添加自定义模型 - 模型唯一ID',
                prompt: '输入此模型的唯一标识符，创建后不可更改',
                placeHolder: '例如：glm-4.6 或 z-ai/glm-4.5-air:free',
                validateInput: value => {
                    if (!value.trim()) {
                        return '模型 ID 不能为空';
                    }
                    if (this.models.some(m => m.id === value.trim())) {
                        return '该 ID 的模型已存在';
                    }
                    return null;
                }
            });

            if (!result || isBackButtonClick(result)) {
                return undefined;
            }
            modelId = result;
        }

        // 第2步/第1步：模型名称
        const modelNameTitle = mode === 'create' ? '添加自定义模型 - 显示名称' : '编辑模型 - 显示名称';
        const modelName = await this._createInputBoxWithBackButton({
            title: modelNameTitle,
            prompt: '输入此模型的显示名称',
            placeHolder: '例如：GLM-4.6',
            value: currentConfig?.name,
            validateInput: value => {
                return !value.trim() ? '模型名称不能为空' : null;
            }
        });
        if (!modelName || isBackButtonClick(modelName)) {
            return undefined;
        }

        // 第3步/第2步：请求模型名称 (model 字段)
        const modelNameForRequest = await this._createInputBoxWithBackButton({
            title: mode === 'create' ? '添加自定义模型 - 请求 模型ID 标识值' : '编辑模型 - 请求 模型ID 标识值',
            prompt: '输入发送 API 请求时使用的 模型ID 标识值',
            placeHolder: '例如：glm-4.6',
            value: currentConfig?.model,
            validateInput: value => {
                return !value.trim() ? '请求模型ID不能为空' : null;
            }
        });
        if (!modelNameForRequest || isBackButtonClick(modelNameForRequest)) {
            return undefined;
        }

        // 第4步/第3步：提供商标识
        const provider = await this._selectProvider(currentConfig?.provider);
        if (isBackButtonClick(provider)) {
            return undefined;
        }

        // 第6步/第5步：API BASE URL
        const urlTitle = mode === 'create' ? '添加自定义模型 - API BASE URL' : '编辑模型 - API BASE URL';
        const url = await this._createInputBoxWithBackButton({
            title: urlTitle,
            prompt: '输入 API 端点 BASE URL',
            placeHolder: '例如：https://api.openai.com/v1 或 https://api.anthropic.com/v1',
            value: currentConfig?.baseUrl,
            validateInput: value => {
                if (!value.trim()) {
                    return 'URL 不能为空';
                }
                try {
                    new URL(value.trim());
                    return null;
                } catch {
                    return '请输入有效的 URL';
                }
            }
        });
        if (!url || isBackButtonClick(url)) {
            return undefined;
        }

        // 第7步/第6步：SDK 模式
        const result = await this._selectSDKMode(mode === 'edit' ? currentConfig?.sdkMode : undefined);
        if (!result || isBackButtonClick(result)) {
            return undefined;
        }
        const sdkMode = result as 'openai' | 'anthropic';

        // 第8步/第7步：能力选择
        const capabilities = await this._selectCapabilities(currentConfig ? currentConfig.capabilities : undefined);
        if (!capabilities || isBackButtonClick(capabilities)) {
            return undefined;
        }

        // 第9步/第8步：Token 限制
        const tokenLimits = await this._configureTokenLimits(currentConfig);
        if (!tokenLimits || isBackButtonClick(tokenLimits)) {
            return undefined;
        }

        // 返回结果根据模式不同
        if (mode === 'create') {
            // 创建模式返回完整的模型对象（默认启用outputThinking）
            return {
                id: modelId!.trim(),
                name: modelName.trim(),
                provider: provider!.trim(),
                baseUrl: url.trim(),
                model: modelNameForRequest.trim(),
                maxInputTokens: tokenLimits.maxInputTokens,
                maxOutputTokens: tokenLimits.maxOutputTokens,
                sdkMode: sdkMode,
                capabilities: capabilities,
                outputThinking: true, // 默认true，高级功能无需用户配置
                _isFromWizard: true
            };
        } else {
            // 编辑模式返回部分更新对象（保留原有 customHeader 和 outputThinking）
            const result: Partial<CompatibleModelConfig> = {
                name: modelName.trim(),
                provider: provider!.trim(),
                baseUrl: url.trim(),
                model: modelNameForRequest.trim(),
                sdkMode: sdkMode,
                capabilities: capabilities,
                maxInputTokens: tokenLimits.maxInputTokens,
                maxOutputTokens: tokenLimits.maxOutputTokens
            };
            // 如果原有配置包含 customHeader，保留它
            if (currentConfig?.customHeader) {
                result.customHeader = currentConfig.customHeader;
            }
            // 如果原有配置包含 outputThinking，保留它
            if (currentConfig?.outputThinking !== undefined) {
                result.outputThinking = currentConfig.outputThinking;
            }
            return result;
        }
    }

    private static async _editModel(
        modelId: string,
        currentConfig: CompatibleModelConfig
    ): Promise<{ action: 'update' | 'delete'; id: string; config?: Partial<CompatibleModelConfig> } | undefined> {
        interface EditActionItem extends vscode.QuickPickItem {
            action: 'edit' | 'delete';
        }
        const items: EditActionItem[] = [
            {
                label: '$(edit) 编辑模型',
                detail: '修改模型配置',
                action: 'edit'
            },
            {
                label: '$(trash) 删除模型',
                detail: '删除此模型配置',
                action: 'delete'
            }
        ];

        const quickPick = vscode.window.createQuickPick<EditActionItem>();
        quickPick.title = `编辑模型：${currentConfig.name}`;
        quickPick.placeholder = '选择一个操作';
        quickPick.items = items;
        quickPick.ignoreFocusOut = true;

        const selected = await new Promise<EditActionItem | BackButtonClick | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];
            disposables.push(
                quickPick.onDidAccept(() => {
                    const selectedItem = quickPick.selectedItems[0];
                    resolve(selectedItem);
                    quickPick.hide();
                })
            );
            disposables.push(
                quickPick.onDidHide(() => {
                    resolve(undefined);
                    disposables.forEach(d => d.dispose());
                })
            );
            quickPick.show();
        });
        if (!selected || isBackButtonClick(selected)) {
            return undefined;
        }

        if (selected.action === 'delete') {
            const confirmed = await vscode.window.showWarningMessage(
                `确定要删除模型"${currentConfig.name}"吗？`,
                { modal: true },
                '删除'
            );
            if (confirmed === '删除') {
                return { action: 'delete', id: modelId };
            }
            return undefined;
        }

        // 编辑模型
        const updatedConfig = await this._configureModel('edit', currentConfig);
        if (updatedConfig && !isBackButtonClick(updatedConfig)) {
            return { action: 'update', id: modelId, config: updatedConfig };
        }
        return undefined;
    }

    /**
     * 获取历史自定义提供商列表
     */
    private static async getHistoricalCustomProviders(): Promise<string[]> {
        try {
            // 导入提供商配置以获取内置提供商列表
            const { configProviders } = await import('../providers/config/index.js');
            const builtinProviders = Object.keys(configProviders);
            const knownProviders = Object.keys(this.KnownProviders);
            // 从现有模型中获取所有唯一的提供商标识
            const allProviders = this.models
                .map(model => model.provider)
                .filter(provider => provider && provider.trim() !== '');
            // 去重并排除内置提供商和 'compatible'
            const customProviders = [...new Set(allProviders)].filter(
                provider =>
                    provider !== 'compatible' &&
                    !builtinProviders.includes(provider) &&
                    !knownProviders.includes(provider)
            );
            return customProviders;
        } catch (error) {
            Logger.error('获取历史自定义提供商失败:', error);
            return [];
        }
    }

    /**
     * 选择提供商标识
     */
    private static async _selectProvider(currentProvider?: string): Promise<string | BackButtonClick | undefined> {
        // 导入提供商配置
        const { configProviders } = await import('../providers/config/index.js');
        type ProviderConfig = import('../types/sharedTypes').ProviderConfig;
        interface ProviderItem extends vscode.QuickPickItem {
            providerId?: string;
        }
        const items: ProviderItem[] = [];
        // 添加已有提供商
        for (const [providerId, providerConfig] of Object.entries(configProviders)) {
            const config = providerConfig as unknown as ProviderConfig;
            items.push({
                label: providerId,
                description: config.displayName || providerId,
                providerId: providerId,
                picked: currentProvider === providerId
            });
        }

        // 添加内置存在适配的供应商列表
        const adaptedProviders = Object.keys(this.KnownProviders);
        const separator1 = { kind: vscode.QuickPickItemKind.Separator };
        items.push(separator1 as ProviderItem);
        for (const provider of adaptedProviders) {
            items.push({
                label: provider,
                description: this.KnownProviders[provider]?.displayName,
                providerId: provider,
                picked: currentProvider === provider
            });
        }

        // 获取历史自定义提供商
        const historicalProviders = await this.getHistoricalCustomProviders();
        // 如果有历史自定义提供商，添加到列表中
        if (historicalProviders.length > 0) {
            const separator2 = { kind: vscode.QuickPickItemKind.Separator };
            items.push(separator2 as ProviderItem);
            for (const provider of historicalProviders) {
                items.push({
                    label: provider,
                    providerId: provider,
                    picked: currentProvider === provider
                });
            }
        }

        // 添加分隔符和自定义选项
        const separator3 = { label: '', kind: vscode.QuickPickItemKind.Separator };
        items.push(separator3 as ProviderItem);
        items.push({
            label: '$(edit) 自定义提供商',
            providerId: '__custom__'
        });

        const quickPick = vscode.window.createQuickPick<ProviderItem>();
        quickPick.title = currentProvider ? '编辑提供商标识' : '选择提供商标识';
        quickPick.placeholder = '选择一个提供商或自定义';
        quickPick.items = items;
        quickPick.ignoreFocusOut = true;

        // 设置为单选模式并预选当前提供商
        if (currentProvider) {
            const currentItem = items.find(item => item.providerId === currentProvider);
            if (currentItem) {
                quickPick.activeItems = [currentItem];
            }
        }

        const selected = await new Promise<ProviderItem | BackButtonClick | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];
            disposables.push(
                quickPick.onDidAccept(() => {
                    const selectedItem = quickPick.selectedItems[0];
                    resolve(selectedItem);
                    quickPick.hide();
                })
            );
            disposables.push(
                quickPick.onDidHide(() => {
                    resolve(undefined);
                    disposables.forEach(d => d.dispose());
                })
            );
            quickPick.show();
        });

        if (!selected || isBackButtonClick(selected)) {
            return isBackButtonClick(selected) ? selected : undefined;
        }

        if (selected.providerId === '__custom__') {
            // 自定义提供商
            const customProvider = await this._createInputBoxWithBackButton({
                title: '添加自定义模型 - 自定义提供商标识',
                prompt: '输入自定义的提供商标识符',
                placeHolder: '例如：my-provider',
                validateInput: value => {
                    // 不能为空
                    if (!value.trim()) {
                        return '提供商标识符不能为空';
                    }
                    if (!/^[a-zA-Z0-9_-]+$/.test(value.trim())) {
                        return '提供商标识符只能包含字母、数字、下划线和连字符';
                    }
                    return null;
                }
            });
            if (!customProvider || isBackButtonClick(customProvider)) {
                return isBackButtonClick(customProvider) ? customProvider : undefined;
            }
            return customProvider.trim();
        }
        return selected.providerId || '';
    }

    /**
     * 选择 SDK 模式
     * @param currentMode - 编辑模式下的当前 SDK 模式
     */
    private static async _selectSDKMode(
        currentMode?: 'openai' | 'anthropic'
    ): Promise<'openai' | 'anthropic' | BackButtonClick | undefined> {
        interface SDKModeItem extends vscode.QuickPickItem {
            mode: 'openai' | 'anthropic';
        }
        const items: SDKModeItem[] = [
            {
                label: 'OpenAI SDK',
                detail: '使用 OpenAI 兼容的 API 格式',
                mode: 'openai',
                picked: currentMode === 'openai'
            },
            {
                label: 'Anthropic SDK',
                detail: '使用 Anthropic 兼容的 API 格式',
                mode: 'anthropic',
                picked: currentMode === 'anthropic'
            }
        ];

        const quickPick = vscode.window.createQuickPick<SDKModeItem>();
        quickPick.title = currentMode ? '编辑 SDK 模式' : '选择 SDK 模式';
        quickPick.placeholder = '选择 SDK 模式';
        quickPick.items = items;
        quickPick.ignoreFocusOut = true;

        // 设置预选项
        if (currentMode) {
            const currentItem = items.find(item => item.mode === currentMode);
            if (currentItem) {
                quickPick.activeItems = [currentItem];
            }
        }

        const selected = await new Promise<SDKModeItem | BackButtonClick | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];
            disposables.push(
                quickPick.onDidAccept(() => {
                    const selectedItem = quickPick.selectedItems[0];
                    resolve(selectedItem);
                    quickPick.hide();
                })
            );
            disposables.push(
                quickPick.onDidHide(() => {
                    resolve(undefined);
                    disposables.forEach(d => d.dispose());
                })
            );
            quickPick.show();
        });
        if (!selected || isBackButtonClick(selected)) {
            return isBackButtonClick(selected) ? selected : undefined;
        }
        return selected.mode;
    }

    /**
     * 选择模型能力
     */
    private static async _selectCapabilities(
        defaults?: CompatibleModelConfig['capabilities']
    ): Promise<CompatibleModelConfig['capabilities'] | BackButtonClick | undefined> {
        const capabilities = {
            toolCalling: defaults?.toolCalling ?? false,
            imageInput: defaults?.imageInput ?? false
        };

        interface CapabilityItem extends vscode.QuickPickItem {
            capability: 'toolCalling' | 'imageInput';
        }
        const items: CapabilityItem[] = [
            {
                label: '工具调用',
                picked: capabilities.toolCalling,
                capability: 'toolCalling'
            },
            {
                label: '图像输入',
                picked: capabilities.imageInput,
                capability: 'imageInput'
            }
        ];

        const quickPick = vscode.window.createQuickPick<CapabilityItem>();
        quickPick.title = '模型能力';
        quickPick.placeholder = '选择模型能力（使用空格切换，按 Enter 确认）';
        quickPick.items = items;
        quickPick.canSelectMany = true;
        quickPick.ignoreFocusOut = true;

        // 设置初始选择
        quickPick.selectedItems = items.filter(item => item.picked);

        const result = await new Promise<CapabilityItem[] | BackButtonClick | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];
            disposables.push(
                quickPick.onDidAccept(() => {
                    const selectedItems = quickPick.selectedItems;
                    resolve([...selectedItems]);
                    quickPick.hide();
                })
            );
            disposables.push(
                quickPick.onDidHide(() => {
                    resolve(undefined);
                    disposables.forEach(d => d.dispose());
                })
            );
            quickPick.show();
        });
        if (!result || isBackButtonClick(result)) {
            return isBackButtonClick(result) ? result : undefined;
        }
        return {
            toolCalling: result.some(item => item.capability === 'toolCalling'),
            imageInput: result.some(item => item.capability === 'imageInput')
        };
    }

    /**
     * 配置 Token 限制
     */
    private static async _configureTokenLimits(defaults?: {
        maxInputTokens: number;
        maxOutputTokens: number;
    }): Promise<{ maxInputTokens: number; maxOutputTokens: number } | BackButtonClick | undefined> {
        // 输入 Token 数
        const maxInputTokensStr = await this._createInputBoxWithBackButton({
            title: '模型 Token 限制 - 最大输入 Token 数',
            prompt: '输入最大输入 Token 数',
            placeHolder: '例如：128000',
            value: defaults?.maxInputTokens?.toString() || '128000',
            validateInput: value => {
                const num = parseInt(value.trim());
                if (isNaN(num) || num <= 0) {
                    return '请输入正数';
                }
                return null;
            }
        });
        if (!maxInputTokensStr || isBackButtonClick(maxInputTokensStr)) {
            return isBackButtonClick(maxInputTokensStr) ? maxInputTokensStr : undefined;
        }

        // 输出 Token 数
        const maxOutputTokensStr = await this._createInputBoxWithBackButton({
            title: '模型 Token 限制 - 最大输出 Token 数',
            prompt: '输入最大输出 Token 数',
            placeHolder: '例如：4096',
            value: defaults?.maxOutputTokens?.toString() || '4096',
            validateInput: value => {
                const num = parseInt(value.trim());
                if (isNaN(num) || num <= 0) {
                    return '请输入正数';
                }
                return null;
            }
        });
        if (!maxOutputTokensStr || isBackButtonClick(maxOutputTokensStr)) {
            return isBackButtonClick(maxOutputTokensStr) ? maxOutputTokensStr : undefined;
        }

        return {
            maxInputTokens: parseInt(maxInputTokensStr.trim()),
            maxOutputTokens: parseInt(maxOutputTokensStr.trim())
        };
    }

    /**
     * 创建带有后退按钮的输入框
     */
    private static _createInputBoxWithBackButton(
        options: vscode.InputBoxOptions
    ): Promise<string | BackButtonClick | undefined> {
        const disposables: vscode.Disposable[] = [];
        const inputBox = vscode.window.createInputBox();
        disposables.push(inputBox);

        inputBox.ignoreFocusOut = true;
        inputBox.title = options.title;
        inputBox.password = options.password || false;
        inputBox.prompt = options.prompt;
        inputBox.placeholder = options.placeHolder;
        inputBox.value = options.value || '';
        inputBox.buttons = [vscode.QuickInputButtons.Back];

        return new Promise<string | BackButtonClick | undefined>(resolve => {
            disposables.push(
                inputBox.onDidTriggerButton(button => {
                    if (button === vscode.QuickInputButtons.Back) {
                        resolve({ back: true });
                        disposables.forEach(d => d.dispose());
                    }
                })
            );
            disposables.push(
                inputBox.onDidAccept(async () => {
                    const value = inputBox.value;
                    if (options.validateInput) {
                        const validation = options.validateInput(value);
                        if (validation) {
                            // 显示验证消息但不隐藏
                            inputBox.validationMessage = (await validation) || undefined;
                            return;
                        }
                    }
                    resolve(value);
                    disposables.forEach(d => d.dispose());
                })
            );
            disposables.push(
                inputBox.onDidHide(() => {
                    resolve(undefined);
                    disposables.forEach(d => d.dispose());
                })
            );
            inputBox.show();
        });
    }
}
