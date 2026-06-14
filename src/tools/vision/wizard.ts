/*---------------------------------------------------------------------------------------------
 *  视觉分析模型选择向导
 *  先选后端类型（MiniMax API / Native 模型），再选提供商和模型。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger, ConfigManager } from '../../utils';
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
    /** 该提供商支持下图像输入的模型列表（裸 ID） */
    models: string[];
}

/**
 * 获取可用的 GCMP 提供商列表（至少有一个支持图像输入的模型）
 * 同步 schema 的模型来源：configProviders + providerOverrides + Compatible Provider
 */
async function getVisionProviders(): Promise<VisionProviderOption[]> {
    const result: VisionProviderOption[] = [];
    const seenKeys = new Set<string>();

    // 1) 内置提供商 + providerOverrides 合并
    for (const [key, cfg] of Object.entries(configProviders)) {
        const effectiveCfg = ConfigManager.applyProviderOverrides(key, cfg);
        const imageModels = (effectiveCfg.models ?? [])
            .filter(m => hasImageCapability(m))
            .map(m => m.id)
            .filter(Boolean);
        if (imageModels.length > 0) {
            result.push({ providerKey: key, displayName: cfg.displayName, models: imageModels });
            seenKeys.add(key);
        }
    }

    // 2) Compatible Provider 中有 imageInput 的模型
    const compatibleModels = CompatibleModelManager.getModels()
        .filter(m => hasImageCapability(m))
        .map(m => m.id)
        .filter(Boolean);
    if (compatibleModels.length > 0 && !seenKeys.has('compatible')) {
        result.push({
            providerKey: 'compatible',
            displayName: t('OpenAI / Anthropic Compatible', 'OpenAI / Anthropic 兼容'),
            models: compatibleModels
        });
    }

    return result;
}

export async function selectVisionModel(): Promise<void> {
    try {
        // 1. 选择后端类型
        const backendPick = await vscode.window.showQuickPick(
            [
                {
                    label: '$(camera) MiniMax Vision API',
                    description: t('MiniMax Token Plan', 'MiniMax Token Plan'),
                    detail: t('Requires MiniMax Token Plan API Key', '需要 MiniMax Token Plan API Key'),
                    value: 'minimax_mcp_understand_image'
                },
                {
                    label: '$(symbol-method) Native Multimodal Model',
                    description: t('Delegate to a GCMP provider model', '委派给 GCMP 提供商的原生多模态模型'),
                    value: 'model'
                }
            ],
            { placeHolder: t('Select vision analysis backend type', '选择视觉分析后端类型') }
        );

        if (!backendPick) {
            return;
        }

        const config = vscode.workspace.getConfiguration('gcmp');

        if (backendPick.value === 'minimax_mcp_understand_image') {
            await config.update('vision.provider', 'minimax_mcp_understand_image', vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                t('Vision analysis backend set to MiniMax Vision API.', '视觉分析后端已设置为 MiniMax Vision API。')
            );
            return;
        }

        // 2. model 模式：一次读取提供商 + 模型列表
        const providers = await getVisionProviders();
        if (providers.length === 0) {
            vscode.window.showWarningMessage(
                t('No GCMP providers with multimodal models available.', '没有支持多模态模型的 GCMP 提供商。')
            );
            return;
        }

        const providerPick = await vscode.window.showQuickPick(
            providers.map(p => ({ label: p.displayName, description: p.providerKey, providerKey: p.providerKey })),
            { placeHolder: t('Select the provider', '选择提供商') }
        );
        if (!providerPick) {
            return;
        }

        // 3. 用缓存数据构建模型列表（不再重复 selectChatModels）
        const provider = providers.find(p => p.providerKey === providerPick.providerKey)!;
        const modelPick = await vscode.window.showQuickPick(
            provider.models.map(id => ({ label: id, description: id, modelId: id })),
            { placeHolder: t('Select the model', '选择模型') }
        );
        if (!modelPick) {
            return;
        }

        // 4. 保存配置
        await config.update('vision.provider', 'model', vscode.ConfigurationTarget.Global);
        await config.update(
            'vision.model',
            { provider: providerPick.providerKey, model: modelPick.modelId },
            vscode.ConfigurationTarget.Global
        );

        vscode.window.showInformationMessage(
            t(
                'Vision analysis model set to {0} / {1}.',
                '视觉分析模型已设置为 {0} / {1}。',
                providerPick.label,
                modelPick.label
            )
        );
    } catch (err) {
        Logger.error('[VisionWizard] Failed:', err instanceof Error ? err.message : String(err));
    }
}
