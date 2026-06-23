/*---------------------------------------------------------------------------------------------
 *  视觉分析模型选择向导
 *  选择原生支持多模态的 GCMP 提供商和模型。
 *  提供商/模型选择界面参照 commit 模式：
 *    - 提供商：label=displayName, description=providerKey, detail=vendor
 *    - 模型：  label=name, description=id, detail=providerKey:modelId
 *  模型列表仍然只保留支持 imageInput 的模型。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/configManager';
import { t } from '../utils/l10n';
import { configProviders } from '../providers/config';
import { CompatibleModelManager } from '../utils/compatibleModelManager';

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
 * 来源：configProviders + providerOverrides + Compatible Provider + GitHub Copilot 原生多模态模型
 */
async function getVisionProviders(): Promise<VisionProviderOption[]> {
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

    // GitHub Copilot 原生多模态模型
    // 仅在当前 vision.model.provider 已设为 "copilot" 时，
    // 才将 copilot 加入向导选项，使已选 Copilot 的用户能正常切换模型。
    const visionProvider = ConfigManager.getConfig().vision.model.provider;
    if (visionProvider === 'copilot') {
        try {
            const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            const copilotVisionModels = copilotModels
                .filter(m => m.capabilities?.supportsImageToText)
                .map(m => ({ id: m.id, name: m.name || m.id }))
                .filter(m => Boolean(m.id));
            if (copilotVisionModels.length > 0) {
                result.push({
                    providerKey: 'copilot',
                    displayName: 'GitHub Copilot',
                    vendor: 'copilot',
                    models: copilotVisionModels
                });
            }
        } catch (err) {
            Logger.warn(
                '[VisionWizard] Failed to query Copilot vision models:',
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    return result;
}

export async function selectVisionModel(): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('gcmp');

        // 1. 选择支持图像输入的提供商（界面参照 commit 模式）
        const providers = await getVisionProviders();
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

        // 2. 选模型（界面参照 commit 模式，模型已按 imageInput 过滤）
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
