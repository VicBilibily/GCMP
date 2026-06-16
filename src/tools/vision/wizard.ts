/*---------------------------------------------------------------------------------------------
 *  视觉分析模型选择向导
 *  先选后端类型（MiniMax API / Native 模型），再选提供商和模型。
 *  提供商/模型选择界面参照 commit 模式：
 *    - 提供商：label=displayName, description=providerKey, detail=vendor
 *    - 模型：  label=name, description=id, detail=providerKey:modelId
 *  模型列表仍然只保留支持 imageInput 的模型。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger, ConfigManager, ApiKeyManager } from '../../utils';
import { t } from '../../utils/l10n';
import { configProviders } from '../../providers/config';
import { CompatibleModelManager } from '../../utils/compatibleModelManager';

/** 从内置 ProviderConfig 判断模型是否支持图像输入 */
function hasImageCapability(m: { capabilities?: { imageInput?: boolean } }): boolean {
    return m.capabilities?.imageInput === true;
}

interface VisionProviderOption {
    providerKey: string;
    displayName: string;
    vendor: string;
    /** 该提供商支持下图像输入的模型列表 */
    models: Array<{ id: string; name: string }>;
}

/**
 * 获取可用的 GCMP 提供商列表（至少有一个支持图像输入的模型）
 * 来源：configProviders + providerOverrides + Compatible Provider
 */
function getVisionProviders(): VisionProviderOption[] {
    const result: VisionProviderOption[] = [];
    const seenKeys = new Set<string>();

    for (const [key, cfg] of Object.entries(configProviders)) {
        const effectiveCfg = ConfigManager.applyProviderOverrides(key, cfg);
        const imageModels = (effectiveCfg.models ?? [])
            .filter(m => hasImageCapability(m))
            .map(m => ({ id: m.id, name: m.name || m.id }))
            .filter(m => Boolean(m.id));
        if (imageModels.length > 0) {
            result.push({
                providerKey: key,
                displayName: cfg.displayName,
                vendor: `gcmp.${key}`,
                models: imageModels
            });
            seenKeys.add(key);
        }
    }

    // Compatible Provider 中有 imageInput 的模型
    const compatibleModels = CompatibleModelManager.getModels()
        .filter(m => hasImageCapability(m))
        .map(m => ({ id: m.id, name: m.name || m.id }))
        .filter(m => Boolean(m.id));
    if (compatibleModels.length > 0 && !seenKeys.has('compatible')) {
        result.push({
            providerKey: 'compatible',
            displayName: t('OpenAI / Anthropic Compatible', 'OpenAI / Anthropic 兼容'),
            vendor: 'gcmp.compatible',
            models: compatibleModels
        });
    }

    return result;
}

export async function selectVisionModel(): Promise<void> {
    try {
        // 检查 minimax-token 密钥是否存在
        const hasMinimaxTokenKey = await ApiKeyManager.hasValidApiKey('minimax-token');

        // 1. 选择后端类型。无 minimax-token 密钥时隐藏 MiniMax API 选项
        interface BackendOption extends vscode.QuickPickItem {
            value: 'minimax_mcp_understand_image' | 'model';
        }

        const backendOptions: BackendOption[] = [];
        if (hasMinimaxTokenKey) {
            backendOptions.push({
                label: '$(camera) MiniMax Vision API',
                description: t('MiniMax Token Plan', 'MiniMax Token Plan'),
                detail: t('Requires MiniMax Token Plan API Key', '需要 MiniMax Token Plan API Key'),
                value: 'minimax_mcp_understand_image' as const
            });
        }
        backendOptions.push({
            label: '$(symbol-method) Native Multimodal Model',
            description: t('Delegate to a GCMP provider model', '委派给 GCMP 提供商的原生多模态模型'),
            value: 'model' as const
        });

        const backendPick = await vscode.window.showQuickPick<BackendOption>(backendOptions, {
            placeHolder: t('Select vision analysis backend type', '选择视觉分析后端类型')
        });
        const backendValue = backendPick?.value;

        if (!backendValue) {
            return;
        }

        const config = vscode.workspace.getConfiguration('gcmp');

        if (backendValue === 'minimax_mcp_understand_image') {
            await config.update('vision.provider', 'minimax_mcp_understand_image', vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                t('Vision analysis backend set to MiniMax Vision API.', '视觉分析后端已设置为 MiniMax Vision API。')
            );
            return;
        }

        // 2. model 模式：选提供商（界面参照 commit 模式）
        const providers = getVisionProviders();
        if (providers.length === 0) {
            vscode.window.showWarningMessage(
                t('No GCMP providers with multimodal models available.', '没有支持多模态模型的 GCMP 提供商。')
            );
            return;
        }

        interface ProviderOption extends vscode.QuickPickItem {
            providerKey: string;
        }

        const providerPick = await vscode.window.showQuickPick<ProviderOption>(
            providers.map(p => ({
                label: p.displayName,
                description: p.providerKey,
                detail: p.vendor,
                providerKey: p.providerKey
            })),
            {
                placeHolder: t('Select the provider that supports multimodal vision', '选择支持多模态视觉的提供商')
            }
        );
        if (!providerPick) {
            return;
        }

        const pickedKey = providerPick.providerKey;
        const pickedProvider = providers.find(p => p.providerKey === pickedKey)!;

        // 3. 选模型（界面参照 commit 模式，模型已按 imageInput 过滤）
        const visionModels = pickedProvider.models;
        if (visionModels.length === 0) {
            vscode.window.showWarningMessage(
                t('No vision-capable models available for this provider.', '该提供商下没有支持视觉的模型。')
            );
            return;
        }

        interface ModelOption extends vscode.QuickPickItem {
            modelId: string;
            modelName: string;
        }

        const modelPick = await vscode.window.showQuickPick<ModelOption>(
            visionModels.map(m => ({
                label: m.name,
                description: m.id,
                detail: `${pickedKey}:${m.id}`,
                modelId: m.id,
                modelName: m.name
            })),
            {
                placeHolder: t('Select the model for vision analysis', '选择用于视觉分析的模型')
            }
        );
        if (!modelPick) {
            return;
        }

        // 4. 保存配置
        await config.update('vision.provider', 'model', vscode.ConfigurationTarget.Global);
        await config.update(
            'vision.model',
            { provider: pickedKey, model: modelPick.modelId },
            vscode.ConfigurationTarget.Global
        );

        vscode.window.showInformationMessage(
            t(
                'Vision analysis model set to {0} / {1}.',
                '视觉分析模型已设置为 {0} / {1}。',
                pickedProvider.displayName,
                modelPick.modelName
            )
        );
    } catch (err) {
        Logger.error('[VisionWizard] Failed:', err instanceof Error ? err.message : String(err));
    }
}
