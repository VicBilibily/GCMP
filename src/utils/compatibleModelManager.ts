/*---------------------------------------------------------------------------------------------
 *  自定义模型管理器
 *  用于管理独立兼容提供商的自定义模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { StatusBarManager } from '../status';
import { KnownProviders } from './knownProviders';
import { configProviders } from '../providers/config';
import { ModelEditor } from '../ui/modelEditor';

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
    sdkMode?: 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses' | 'gemini-sse';
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
    /** 多轮对话消息是否必须包含思考内容（默认false）*/
    includeThinking?: boolean;
    /**
     * 是否在 Responses API 中使用 instructions 参数（默认false）
     *  - 当设置为 true 时，使用 instructions 参数传递系统指令
     *  - 当设置为 false 时，使用用户消息传递系统消息指令
     */
    useInstructions?: boolean;
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
    private static isSaving = false; // 标记是否正在保存，避免触发配置监听器

    static getSdkModeLabel(sdkMode: CompatibleModelConfig['sdkMode']): string {
        switch (sdkMode) {
            case 'anthropic':
                return 'Anthropic';
            case 'gemini-sse':
                return 'Gemini';
            case 'openai':
            case 'openai-sse':
            case 'openai-responses':
            default:
                return 'OpenAI';
        }
    }

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
                // 如果正在保存，忽略配置变化（避免重新加载覆盖内存中的数据）
                if (this.isSaving) {
                    Logger.debug('正在保存配置，跳过重新加载');
                    return;
                }
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
            this.models = (modelsData || []).filter(
                model => model != null && typeof model === 'object' && model.id && model.name && model.provider
            ); // 过滤掉无效模型
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
            this.isSaving = true; // 设置保存标记
            const config = vscode.workspace.getConfiguration('gcmp');
            // 保存时移除内部标记字段和值为 undefined 或 null 的字段
            const modelsToSave = this.models
                .filter(model => model != null && typeof model === 'object')
                .map(model => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { _isFromWizard, ...rest } = model;
                    // 移除值为 undefined 或 null 的字段（用户清空的字段）
                    const cleaned: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(rest)) {
                        // 过滤掉 undefined 和 null 值
                        if (value !== undefined && value !== null) {
                            cleaned[key] = value;
                        }
                    }
                    return cleaned;
                });

            Logger.debug('准备保存模型，清理后的数据:', JSON.stringify(modelsToSave, null, 2));

            await config.update('compatibleModels', modelsToSave, vscode.ConfigurationTarget.Global);
            Logger.debug('自定义模型已保存到配置');

            // 保存成功后立即从配置文件重新加载，确保内存与配置文件同步
            // 这样可以确保被清空的字段（undefined/null）从内存中也被移除
            this.loadModels();

            // 手动触发模型变化事件，通知所有监听器（如 CompatibleProvider）
            this._onDidChangeModels.fire();
            Logger.debug('已触发模型变化事件');
        } catch (error) {
            Logger.error('保存自定义模型失败:', error);
            throw error;
        } finally {
            // 延迟重置标记，确保配置变化事件已触发
            setTimeout(() => {
                this.isSaving = false;
            }, 100);
        }
    }

    /**
     * 获取所有模型
     */
    static getModels(): CompatibleModelConfig[] {
        return this.models;
    }

    /**
     * 从配置文件获取指定模型的原始数据（未经处理）
     * @param modelId 模型ID
     * @returns 原始模型配置，或 undefined
     */
    private static getRawModelFromConfig(modelId: string): CompatibleModelConfig | undefined {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            const modelsData = config.get<CompatibleModelConfig[]>('compatibleModels', []);
            const rawModel = modelsData.find(model => model && model.id === modelId);

            // 返回原始数据，不做任何处理（包括不添加默认 tooltip）
            return rawModel;
        } catch (error) {
            Logger.error('从配置文件读取原始模型数据失败:', error);
            return undefined;
        }
    }
    /**
     * 添加模型
     */
    static async addModel(model: CompatibleModelConfig): Promise<void> {
        // 检查模型是否为空
        if (!model) {
            throw new Error('模型配置不能为空');
        }

        // 检查必需字段
        if (!model.id || !model.name || !model.provider) {
            throw new Error('模型配置缺少必需字段 (id, name, provider)');
        }

        // 检查模型ID是否已存在
        if (this.models.some(m => m.id === model.id)) {
            throw new Error(`模型 ID "${model.id}" 已存在`);
        }

        // 确保模型对象是有效的
        if (typeof model !== 'object') {
            throw new Error('模型配置必须是有效的对象');
        }

        // 确保capabilities对象存在
        if (!model.capabilities || typeof model.capabilities !== 'object') {
            model.capabilities = {
                toolCalling: false,
                imageInput: false
            };
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
        // 检查更新数据是否为空
        if (!updates) {
            throw new Error('更新数据不能为空');
        }

        const index = this.models.findIndex(m => m.id === id);
        if (index === -1) {
            throw new Error(`未找到模型 ID "${id}"`);
        }

        // 确保现有模型不为空
        if (!this.models[index]) {
            throw new Error(`模型数据损坏，无法更新模型 ID "${id}"`);
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

        // 确保要删除的模型不为空
        if (!removedModel) {
            throw new Error(`模型数据损坏，无法删除模型 ID "${id}"`);
        }

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

            // 获取历史自定义提供商
            const historicalProviders = await this.getHistoricalCustomProviders();

            const customProviders: string[] = [];
            const knownProviders: string[] = [];
            const builtinProviders: string[] = [];

            providers.forEach(provider => {
                if (historicalProviders.includes(provider)) {
                    customProviders.push(provider);
                } else if (provider in KnownProviders) {
                    knownProviders.push(provider);
                } else if (provider in configProviders) {
                    builtinProviders.push(provider);
                } else {
                    // 默认归类为自定义提供商
                    customProviders.push(provider);
                }
            });

            // 按自定义、已知、内置的顺序创建选择项，并添加分隔线
            const providerChoices = [];

            // 自定义提供商
            if (customProviders.length > 0) {
                providerChoices.push(...customProviders.map(provider => ({ label: provider })));
            }

            // 已知提供商（添加分隔线）
            if (knownProviders.length > 0) {
                if (customProviders.length > 0) {
                    providerChoices.push({ label: '已知提供商', kind: vscode.QuickPickItemKind.Separator });
                }
                providerChoices.push(
                    ...knownProviders.map(provider => ({
                        label: provider,
                        description: KnownProviders[provider]?.displayName
                    }))
                );
            }

            // 内置提供商（添加分隔线）
            if (builtinProviders.length > 0) {
                if (customProviders.length > 0 || knownProviders.length > 0) {
                    providerChoices.push({ label: '内置提供商', kind: vscode.QuickPickItemKind.Separator });
                }
                providerChoices.push(
                    ...builtinProviders.map(provider => ({
                        label: provider,
                        description: configProviders[provider as keyof typeof configProviders]?.displayName
                    }))
                );
            }

            // 如果有多个提供商，让用户选择
            const selected = await vscode.window.showQuickPick(providerChoices, {
                placeHolder: '选择要设置 API 密钥的提供商'
            });
            if (!selected) {
                return;
            }
            await this.setApiKeyForProvider(selected.label);
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
                    `$(chip) ${this.getSdkModeLabel(model.sdkMode)}`
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
            // 如果没有模型，直接使用可视化编辑器添加
            if (items.length === 0) {
                const newModel = await this.showVisualModelEditorForCreate();
                if (newModel) {
                    await this.addModel(newModel);
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
                const newModel = await this.showVisualModelEditorForCreate();
                if (newModel) {
                    await this.addModel(newModel);
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

    private static async _editModel(
        modelId: string,
        currentConfig: CompatibleModelConfig
    ): Promise<{ action: 'update' | 'delete'; id: string; config?: Partial<CompatibleModelConfig> } | undefined> {
        // 从配置文件读取原始数据（未经处理的）
        const rawConfig = this.getRawModelFromConfig(modelId);
        // 如果无法读取原始数据，使用内存中的数据作为后备
        const configToEdit = rawConfig || currentConfig;

        // 直接显示可视化表单编辑器
        const updatedConfig = await this.showVisualModelEditor(configToEdit);
        if (updatedConfig) {
            return { action: 'update', id: modelId, config: updatedConfig };
        }
        return undefined;
    }

    /**
     * 显示可视化模型编辑器（创建模式）
     * @returns 新模型配置，或 undefined 如果取消
     */
    private static async showVisualModelEditorForCreate(): Promise<CompatibleModelConfig | undefined> {
        // 创建默认的新模型配置
        const defaultModel: CompatibleModelConfig = {
            id: '', // 将在表单中由用户填写
            name: '', // 将在表单中由用户填写
            provider: '', // 将在表单中由用户选择填写
            sdkMode: 'openai',
            maxInputTokens: 128000,
            maxOutputTokens: 4096,
            capabilities: {
                toolCalling: true,
                imageInput: false
            }
        };

        return this.showVisualModelEditor(defaultModel, true);
    }

    /**
     * 显示可视化模型编辑器
     * @param model 要编辑的模型配置
     * @param isCreateMode 是否为创建模式
     * @returns 更新后的模型配置，或 undefined 如果取消
     */
    private static async showVisualModelEditor(
        model: CompatibleModelConfig,
        isCreateMode: boolean = false
    ): Promise<CompatibleModelConfig | undefined> {
        const result = await ModelEditor.show(model, isCreateMode);

        // 检查是否为删除操作
        if (result && '_deleteModel' in result && result._deleteModel) {
            // 执行删除操作
            try {
                await this.removeModel(result.modelId);
                vscode.window.showInformationMessage('模型已删除');
            } catch (error) {
                vscode.window.showErrorMessage(`删除模型失败: ${error instanceof Error ? error.message : '未知错误'}`);
            }
            return undefined;
        }

        return result as CompatibleModelConfig | undefined;
    }

    /**
     * 获取历史自定义提供商列表
     */
    private static async getHistoricalCustomProviders(): Promise<string[]> {
        try {
            // 导入提供商配置以获取内置提供商列表
            const { configProviders } = await import('../providers/config/index.js');
            const builtinProviders = Object.keys(configProviders);
            const knownProviders = Object.keys(KnownProviders);
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
}
