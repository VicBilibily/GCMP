/*---------------------------------------------------------------------------------------------
 *  快手万擎配置向导
 *  提供交互式向导来配置API密钥和推理点ID
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager } from './configManager';
import { ModelConfig, UserConfigOverrides, ModelOverride, ProviderConfig } from '../types/sharedTypes';

export interface StreamlakeModel extends ModelConfig {
    serviceId?: string;
}

export class StreamlakeWizard {
    private static readonly PROVIDER_KEY = 'streamlake';
    private static readonly INFERENCE_POINT_ID_REGEX = /^ep-[a-zA-Z0-9]{6}-\d{19}$/;

    /**
     * 启动配置向导
     */
    static async startWizard(providerConfig: ProviderConfig, displayName: string): Promise<void> {
        try {
            // 第一步：检查 API Key
            const hasApiKey = await ApiKeyManager.hasValidApiKey(this.PROVIDER_KEY);
            if (!hasApiKey) {
                // 没有 API Key，先设置 API Key
                Logger.debug('检测到未设置 API Key，启动 API Key 设置流程');
                const apiKeySet = await this.showSetApiKeyStep(displayName, providerConfig.apiKeyTemplate);
                if (!apiKeySet) {
                    // 用户取消了 API Key 设置
                    Logger.debug('用户取消了 API Key 设置');
                    return;
                }
                Logger.debug('API Key 设置成功，进入操作菜单');
            }
            // 第二步：显示操作菜单
            await this.showOperationMenu(providerConfig);
        } catch (error) {
            Logger.error(`配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 显示设置 API Key 步骤
     * 允许用户输入空值来清除 API Key
     */
    private static async showSetApiKeyStep(displayName: string, apiKeyTemplate: string): Promise<boolean> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 API Key（留空可清除）`,
            title: `设置 ${displayName} API Key`,
            placeHolder: apiKeyTemplate,
            password: true
        });

        // 用户取消了输入
        if (result === undefined) {
            return false;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result);
                Logger.info(`${displayName} API Key 已设置`);
            }
            return true;
        } catch (error) {
            Logger.error(`API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            return false;
        }
    }

    /**
     * 显示操作菜单
     */
    private static async showOperationMenu(providerConfig: ProviderConfig): Promise<void> {
        while (true) {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) 修改 快手万擎 API Key',
                        detail: '设置或删除 快手万擎 API Key',
                        action: 'updateApiKey'
                    },
                    {
                        label: '$(settings-gear) 设置模型推理点ID',
                        detail: '为在线推理预置模型配置推理点ID',
                        action: 'setModelEndpoint'
                    }
                ],
                {
                    title: '快手万擎 配置菜单',
                    placeHolder: '选择要执行的操作'
                }
            );
            if (!choice) {
                break;
            }
            if (choice.action === 'updateApiKey') {
                const apiKeySet = await this.showSetApiKeyStep('快手万擎', providerConfig.apiKeyTemplate);
                if (!apiKeySet) {
                    continue;
                }
            } else if (choice.action === 'setModelEndpoint') {
                await this.showSetModelEndpointStep(providerConfig.models);
            }
        }
    }

    /**
     * 显示设置模型推理点ID步骤
     */
    private static async showSetModelEndpointStep(models: StreamlakeModel[]): Promise<void> {
        const modelChoices = models.map(model => ({
            label: model.name,
            detail: this.getModelDetail(model),
            modelId: model.id,
            model: model
        }));
        const selected = await vscode.window.showQuickPick(modelChoices, {
            title: '选择要配置的模型',
            placeHolder: '选择模型来配置推理点ID'
        });
        if (!selected) {
            return;
        }
        await this.showEndpointIdInputStep(selected.model, models);
    }

    /**
     * 显示推理点ID输入步骤
     * 允许为空来清除推理点ID设置，设置完毕后返回模型列表
     */
    private static async showEndpointIdInputStep(model: StreamlakeModel, models: StreamlakeModel[]): Promise<void> {
        const currentEndpointId = await this.getModelEndpointId(model.id);
        const endpointId = await vscode.window.showInputBox({
            prompt: `为 ${model.name} 设置推理点ID（留空可清除）`,
            title: `设置推理点ID - ${model.name}`,
            placeHolder: 'ep-xxxxxx-xxxxxxxxxxxxxxxxxxx',
            value: currentEndpointId || '',
            validateInput: (value: string) => {
                // 允许空值来清除设置
                if (!value || value.trim() === '') {
                    return null;
                }
                const trimmedValue = value.trim();
                if (!this.INFERENCE_POINT_ID_REGEX.test(trimmedValue)) {
                    return '请输入正确的推理点ID（格式为: ep-xxxxxx-xxxxxxxxxxxxxxxxxxx）';
                }
                return null;
            }
        });
        if (endpointId === undefined) {
            return;
        }
        try {
            const trimmedEndpointId = endpointId.trim();
            if (trimmedEndpointId === '') {
                // 清除推理点ID
                await this.clearModelEndpointId(model.id);
            } else {
                // 保存推理点ID
                await this.saveModelEndpointId(model.id, trimmedEndpointId);
            }
            // 设置完毕后，返回模型列表而不是菜单选项
            await this.showSetModelEndpointStep(models);
        } catch (error) {
            vscode.window.showErrorMessage(`操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 获取模型的详情
     */
    private static getModelDetail(model: StreamlakeModel): string {
        try {
            const overrides = ConfigManager.getProviderOverrides();
            const streamlakeOverride = overrides['streamlake'];
            if (streamlakeOverride?.models) {
                const modelOverride = streamlakeOverride.models.find(m => m.id === model.id);
                if (modelOverride?.model) {
                    return `$(pass-filled) ${modelOverride.model}`;
                }
            }
            if (model.model) {
                return `$(pass-filled) ${model.model}`;
            }
            return '$(circle-large-outline) 未设置推理点ID';
        } catch {
            return '$(circle-large-outline) 未设置推理点ID';
        }
    }

    /**
     * 获取模型的推理点ID
     */
    private static async getModelEndpointId(modelId: string): Promise<string | null> {
        try {
            const overrides = ConfigManager.getProviderOverrides();
            const streamlakeOverride = overrides['streamlake'];
            if (streamlakeOverride?.models) {
                const modelOverride = streamlakeOverride.models.find(m => m.id === modelId);
                if (modelOverride?.model) {
                    return modelOverride.model;
                }
            }
        } catch {
            // 忽略错误
        }
        return null;
    }

    /**
     * 保存模型的推理点ID
     */
    public static async saveModelEndpointId(modelId: string, endpointId: string): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            // 每次都从配置系统读取最新的值（深度副本）
            const overrides = JSON.parse(JSON.stringify(config.get<UserConfigOverrides>('providerOverrides', {})));
            // 初始化 streamlake 覆盖配置
            if (!overrides['streamlake']) {
                overrides['streamlake'] = { models: [] };
            }
            // 初始化 models 数组
            if (!overrides['streamlake'].models) {
                overrides['streamlake'].models = [];
            }

            // 查找是否已存在该模型的推理点ID配置
            const existingIndex = overrides['streamlake'].models.findIndex((m: ModelOverride) => m.id === modelId);
            if (existingIndex >= 0) {
                // 更新现有配置
                overrides['streamlake'].models[existingIndex].model = endpointId;
            } else {
                // 添加新配置
                overrides['streamlake'].models.push({
                    id: modelId,
                    model: endpointId
                });
            }

            // 保存到 VS Code 全局配置
            await config.update('providerOverrides', overrides, vscode.ConfigurationTarget.Global);
            Logger.info(`已保存模型 ${modelId} 的推理点ID: ${endpointId}`);
            vscode.window.showInformationMessage(`✅ 模型 ${modelId} 推理点ID 已保存`);
        } catch (error) {
            const errorMessage = `保存推理点ID失败: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            throw error;
        }
    }

    /**
     * 清除模型的推理点ID
     * 如果只覆盖设置了model字段，则移除整个配置
     * 否则只删除model字段
     */
    public static async clearModelEndpointId(modelId: string): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            // 每次都从配置系统读取最新的值（深度副本）
            const overrides = JSON.parse(JSON.stringify(config.get<UserConfigOverrides>('providerOverrides', {})));
            if (overrides['streamlake']?.models) {
                // 查找该模型的配置
                const existingIndex = overrides['streamlake'].models.findIndex((m: ModelOverride) => m.id === modelId);
                if (existingIndex >= 0) {
                    const modelOverride = overrides['streamlake'].models[existingIndex];
                    // 检查该配置是否只有 id 和 model 两个字段
                    const keys = Object.keys(modelOverride);
                    if (keys.length === 2 && keys.includes('id') && keys.includes('model')) {
                        // 只覆盖设置了 model，移除整个配置项
                        overrides['streamlake'].models.splice(existingIndex, 1);
                    } else {
                        // 有其他字段，只删除 model 字段
                        delete modelOverride.model;
                    }
                    // 保存到 VS Code 全局配置
                    await config.update('providerOverrides', overrides, vscode.ConfigurationTarget.Global);
                    Logger.info(`已清除模型 ${modelId} 的推理点ID`);
                    vscode.window.showInformationMessage(`✅ 模型 ${modelId} 推理点ID 已清除`);
                }
            }
        } catch (error) {
            const errorMessage = `清除推理点ID失败: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            throw error;
        }
    }

    /**
     * 验证推理点ID格式
     */
    static validateInferencePointId(value: string): boolean {
        return this.INFERENCE_POINT_ID_REGEX.test(value.trim());
    }
}
