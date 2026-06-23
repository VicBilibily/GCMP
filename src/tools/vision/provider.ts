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

    const providerConfigs = ConfigManager.getConfigProvider();

    /**
     * 解析模型选择为 LanguageModelChat。
     * - copilot：按 vendor + id 精准查找
     * - compatible：使用 CompatibleModelManager 获取动态模型列表
     * - 其他：检查模型是否有独立的 provider 字段
     * 查找失败返回 null（不抛错，由调用方决定后续行为）。
     */
    const resolveModel = async (
        selection: { provider?: string; model?: string } | undefined
    ): Promise<vscode.LanguageModelChat | null> => {
        const provider = (selection?.provider ?? '').trim();
        const modelId = (selection?.model ?? '').trim();
        if (!provider || !modelId) {
            return null;
        }

        try {
            if (provider === 'copilot') {
                const [m] = await vscode.lm.selectChatModels({ vendor: 'copilot', id: modelId });
                return m ?? null;
            }
            if (provider === 'compatible') {
                const models = CompatibleModelManager.getModels();
                const matched = models.find(m => m.id === modelId);
                if (!matched) {
                    return null;
                }
                const queryId = `gcmp.${matched.provider || 'compatible'}:::${modelId}`;
                const [m] = await vscode.lm.selectChatModels({ id: queryId, vendor: 'gcmp.compatible' });
                return m ?? null;
            }
            // 非 compatible：检查模型是否有独立的 provider 字段
            const baseConfig = providerConfigs[provider as keyof typeof providerConfigs];
            const effectiveConfig = baseConfig ? ConfigManager.applyProviderOverrides(provider, baseConfig) : undefined;
            const matchedModel = effectiveConfig?.models.find(m => m.id === modelId);
            const actualProvider = matchedModel?.provider || provider;
            const queryId = `gcmp.${actualProvider}:::${modelId}`;
            const [m] = await vscode.lm.selectChatModels({ id: queryId, vendor: `gcmp.${provider}` });
            return m ?? null;
        } catch {
            return null;
        }
    };

    // 1) 优先使用已配置且可用的模型
    const configuredSelection = ConfigManager.getConfig().vision.model;
    let model = await resolveModel(configuredSelection);
    if (model) {
        Logger.trace(`[gcmpVisionTool] Using configured model: ${model.name}`);
    } else {
        // 2) 未配置或配置失效：弹出模型选择向导，并在成功选择后重试
        const reason =
            !configuredSelection.provider || !configuredSelection.model ?
                'No vision model configured'
            :   'Configured vision model unavailable';
        Logger.warn(`[gcmpVisionTool] ${reason}, launching wizard`);

        const before = JSON.stringify(configuredSelection ?? {});
        await vscode.commands.executeCommand('gcmp.vision.selectModel');

        const afterSelection = ConfigManager.getConfig().vision.model;
        const after = JSON.stringify(afterSelection ?? {});
        if (after === before) {
            // 用户未更新配置（通常表示取消/关闭了向导）
            throw new vscode.CancellationError();
        }

        model = await resolveModel(afterSelection);
        if (!model) {
            const providerKey =
                (afterSelection?.provider || configuredSelection?.provider || '(unspecified)').trim() ||
                '(unspecified)';
            const modelId =
                (afterSelection?.model || configuredSelection?.model || '(unspecified)').trim() || '(unspecified)';
            throw new Error(
                `Configured vision model "${providerKey}:${modelId}" is unavailable or not enabled. ` +
                    'Run "GCMP: Select Vision Model" to choose another one, or check whether the provider model is enabled.'
            );
        }
        Logger.trace(`[gcmpVisionTool] Using user-selected model: ${model.name}`);
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
