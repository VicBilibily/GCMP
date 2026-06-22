/*---------------------------------------------------------------------------------------------
 *  Vision 统一分析入口
 *  完全基于原生支持多模态的 GCMP 模型（LLM 聊天模型）进行视觉分析。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger, ConfigManager, CompatibleModelManager } from '../../utils';

/**
 * Vision 分析结果
 */
export interface VisionResult {
    content: string;
}

const SUPPORTED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']);

function validateImageFile(filePath: string): void {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Image file not found: ${filePath}`);
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
        Logger.warn(`[gcmpVisionTool] Unsupported image extension: .${ext}, trying anyway`);
    }
}

/**
 * 分析图片视觉内容（带自定义系统提示词）
 * 完全委托给 gcmp.vision.model 配置的原生多模态模型。
 * 当模型未配置时，拉起配置向导让用户选择。
 */
export async function analyzeImagesWithSystem(
    filePaths: string[],
    systemPrompt: string,
    prompt = '',
    token?: vscode.CancellationToken
): Promise<VisionResult> {
    if (filePaths.length === 0) {
        throw new Error('At least one image file is required.');
    }
    filePaths.forEach(validateImageFile);

    if (token?.isCancellationRequested) {
        throw new Error('Vision analysis cancelled before processing started.');
    }

    let visionModel = ConfigManager.getConfig().vision.model;
    if (!visionModel.provider || !visionModel.model) {
        Logger.warn('[gcmpVisionTool] No vision model configured, launching wizard');
        await (await import('../../wizards/visionWizard')).selectVisionModel();
        visionModel = ConfigManager.getConfig().vision.model;
        if (!visionModel.provider || !visionModel.model) {
            throw new Error(
                'Vision analysis is not configured. Please configure a vision model via the wizard or set gcmp.vision.model in settings.'
            );
        }
    }

    const providerConfigs = ConfigManager.getConfigProvider();
    const allModels = await vscode.lm.selectChatModels({});
    let model: vscode.LanguageModelChatInformation | undefined;

    if (visionModel.provider === 'compatible') {
        // compatible 提供商：使用 CompatibleModelManager 获取动态模型列表
        const models = CompatibleModelManager.getModels();
        const matched = models.find(m => m.id === visionModel.model);
        const actualProvider = matched?.provider || 'compatible';
        const fullModelId = `gcmp.${actualProvider}:::${visionModel.model}`;
        model = allModels.find(m => m.id === fullModelId);
    } else {
        // 非 compatible：检查模型是否有独立的 provider 字段
        const baseConfig = providerConfigs[visionModel.provider as keyof typeof providerConfigs];
        const effectiveConfig =
            baseConfig ? ConfigManager.applyProviderOverrides(visionModel.provider, baseConfig) : undefined;
        const matchedModel = effectiveConfig?.models.find(m => m.id === visionModel.model);
        const actualProvider = matchedModel?.provider || visionModel.provider;
        const fullModelId = `gcmp.${actualProvider}:::${visionModel.model}`;
        model = allModels.find(m => m.id === fullModelId);
    }

    if (!model) {
        throw new Error(`Vision model not found: gcmp.${visionModel.provider}:::${visionModel.model}. Please check gcmp.vision.model configuration.`);
    }

    const imageParts = filePaths.map(filePath => {
        const ext = path.extname(filePath).slice(1) || 'png';
        const base64 = fs.readFileSync(filePath).toString('base64');
        return new vscode.LanguageModelDataPart(Buffer.from(base64, 'base64'), `image/${ext}`);
    });

    const systemMessage = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, systemPrompt);
    const userMessage = vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(prompt), ...imageParts]);

    const cts = token ? undefined : new vscode.CancellationTokenSource();
    try {
        const response = await model.sendRequest(
            [systemMessage, userMessage],
            { modelOptions: { requestKind: 'vision-recognition' as const } },
            token ?? cts!.token
        );
        let content = '';
        for await (const chunk of response.text) {
            content += chunk;
        }
        return { content };
    } finally {
        cts?.dispose();
    }
}
