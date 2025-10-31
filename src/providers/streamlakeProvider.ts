/*---------------------------------------------------------------------------------------------
 *  快手万擎 Provider
 *  为快手万擎供应商提供模型覆盖检查功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    Progress,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig, ModelConfig, UserConfigOverrides, ModelOverride } from '../types/sharedTypes';
import { Logger, ApiKeyManager, ConfigManager } from '../utils';

/**
 * 快手万擎供应商类
 * 继承自 GenericModelProvider，添加推理点ID验证功能
 */
export class StreamlakeProvider extends GenericModelProvider {
    constructor(providerKey: string, providerConfig: ProviderConfig) {
        super(providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 根据配置创建并激活供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: StreamlakeProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 模型扩展已激活!`);
        // 创建供应商实例
        const provider = new StreamlakeProvider(providerKey, providerConfig);
        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
        });
        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 检查模型是否有覆盖的 model 值（推理点ID）
     * 如果没有设置，则弹出输入框提示用户输入
     * 返回最终的模型值（推理点ID）
     */
    private async ensureModelOverride(modelConfig: ModelConfig): Promise<string> {
        const modelId = modelConfig.id;
        // 获取覆盖配置
        const overrides = ConfigManager.getProviderOverrides();
        const streamlakeOverride = overrides['streamlake'];
        // 检查该模型是否已有推理点ID覆盖值
        if (streamlakeOverride?.models) {
            const modelOverride = streamlakeOverride.models.find(m => m.id === modelId);
            if (modelOverride?.model) {
                Logger.debug(`模型 ${modelId} 已有推理点ID: ${modelOverride.model}`);
                return modelOverride.model;
            }
        }

        // 如果模型配置本身有推理点ID，则使用它
        if (modelConfig.model) {
            Logger.debug(`模型 ${modelId} 使用配置中的推理点ID: ${modelConfig.model}`);
            return modelConfig.model;
        }
        // 没有设置，弹出输入框
        Logger.info(`模型 ${modelId} 未设置推理点ID，弹出输入框`);

        const userInput = await vscode.window.showInputBox({
            prompt: `请输入${modelConfig.name}的推理点ID（可从快手万擎控制台查看）`,
            title: `设置快手万擎推理点ID - ${modelConfig.name}`,
            placeHolder: 'ep-xxxxxx-xxxxxxxxxxxxxxxxxxx',
            validateInput: (value: string) => {
                if (!value || value.trim() === '') {
                    return '推理点ID不能为空';
                }
                const trimmedValue = value.trim();
                // 验证推理点ID格式: ep-6位字符-19位数字
                const inferencePointIdRegex = /^ep-[a-zA-Z0-9]{6}-\d{19}$/;
                if (!inferencePointIdRegex.test(trimmedValue)) {
                    return '请输入正确的推理点ID（格式为: ep-xxxxxx-xxxxxxxxxxxxxxxxxxx）';
                }
                return null;
            }
        });
        if (!userInput) {
            // 用户取消了输入
            const errorMessage = `用户取消了模型 ${modelId} 的推理点ID设置。请访问 https://console.streamlake.com/wanqing/inference/list 新增或查看推理点`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const modelValue = userInput.trim();
        Logger.info(`用户为模型 ${modelId} 设置推理点ID: ${modelValue}`);

        // 保存用户输入到配置中
        await this.saveModelOverrideToConfig(modelId, modelValue);
        return modelValue;
    }

    /**
     * 保存 推理点ID 到 VS Code 配置
     */
    private async saveModelOverrideToConfig(modelId: string, modelValue: string): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            const overrides = config.get<UserConfigOverrides>('providerOverrides', {});
            // 初始化 streamlake 覆盖配置
            if (!overrides['streamlake']) {
                overrides['streamlake'] = { models: [] };
            }
            // 初始化 models 数组
            if (!overrides['streamlake'].models) {
                overrides['streamlake'].models = [];
            }

            // 查找是否已存在该模型的推理点ID配置
            const existingIndex = overrides['streamlake'].models!.findIndex((m: ModelOverride) => m.id === modelId);
            if (existingIndex >= 0) {
                // 更新现有配置
                overrides['streamlake'].models![existingIndex].model = modelValue;
            } else {
                // 添加新配置
                overrides['streamlake'].models!.push({
                    id: modelId,
                    model: modelValue
                });
            }

            // 保存到 VS Code 配置
            await config.update('providerOverrides', overrides, vscode.ConfigurationTarget.Global);
            Logger.info(`已保存模型 ${modelId} 的推理点ID: ${modelValue}`);
        } catch (error) {
            const errorMessage = `保存推理点ID失败: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            vscode.window.showErrorMessage(`❌ 保存推理点ID失败: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * 覆盖 provideLanguageModelChatResponse 方法
     * 在发起请求前检查并确保推理点ID已设置
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.providerConfig.models.find((m: ModelConfig) => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 检查并确保推理点ID已设置
        const epId = await this.ensureModelOverride(modelConfig);
        if (epId) {
            modelConfig.model = epId;
        }

        // 调用父类的实现继续处理请求
        await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
    }
}
