/*---------------------------------------------------------------------------------------------
 *  Vision 统一分析入口
 *  根据配置自动路由：
 *    - vision.provider === "minimax_mcp_understand_image" → MiniMax Token Plan Vision API（专用 HTTP 接口）
 *    - vision.provider === "model"   → 委派给原生支持多模态的 GCMP 模型（LLM 聊天模型）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger, ConfigManager } from '../../utils';
import { MiniMaxVisionTool } from './minimaxVision';

/**
 * Vision 分析系统提示词
 * 用于委托给 LLM 模型时，确保模型以图像分析专家的角色工作
 */
const VISION_SYSTEM_PROMPT =
    'You are an image analysis assistant. Your task is to analyze the visual content of images ' +
    'and provide accurate, detailed descriptions. Include any text, charts, UI elements, code, ' +
    'or other visible information. Answer any specific questions the user has about the image. ' +
    'Be concise but thorough in your analysis.';

/**
 * Vision 分析结果
 */
export interface VisionResult {
    content: string;
}

// ─── MiniMax Token Plan API 路径 ───────────────────────────────────────

async function analyzeViaMinimaxAPI(
    filePath: string,
    prompt?: string,
    token?: vscode.CancellationToken
): Promise<VisionResult> {
    const ext = path.extname(filePath).slice(1) || 'png';
    const base64 = fs.readFileSync(filePath).toString('base64');
    const imageUrl = `data:image/${ext};base64,${base64}`;

    const tool = new MiniMaxVisionTool();
    let abortSignal: AbortSignal | undefined;
    if (token) {
        if (token.isCancellationRequested) {
            abortSignal = AbortSignal.abort();
        } else {
            const ac = new AbortController();
            token.onCancellationRequested(() => ac.abort());
            abortSignal = ac.signal;
        }
    }
    const result = await tool.understand(
        {
            prompt:
                prompt ||
                'Please describe this image in detail, including any text, charts, code, or other visible elements.',
            image_url: imageUrl
        },
        abortSignal
    );

    return { content: result.content };
}

// ─── LLM 聊天模型委派路径 ─────────────────────────────────────────────

async function analyzeViaModel(
    filePath: string,
    prompt: string | undefined,
    providerKey: string,
    modelId: string,
    token?: vscode.CancellationToken
): Promise<VisionResult> {
    const ext = path.extname(filePath).slice(1) || 'png';
    const base64 = fs.readFileSync(filePath).toString('base64');
    const mimeType = `image/${ext}`;

    // 参照 commit 模式：检查模型是否有独立的 provider 字段
    const providerConfigs = ConfigManager.getConfigProvider();
    const baseConfig = providerConfigs[providerKey as keyof typeof providerConfigs];
    const effectiveConfig = baseConfig ? ConfigManager.applyProviderOverrides(providerKey, baseConfig) : undefined;
    const matchedModel = effectiveConfig?.models.find(m => m.id === modelId);
    const actualProvider = matchedModel?.provider || providerKey;
    const fullModelId = `gcmp.${actualProvider}:::${modelId}`;
    const allModels = await vscode.lm.selectChatModels({});
    const model = allModels.find(m => m.id === fullModelId);

    if (!model) {
        throw new Error(`Vision model not found: ${fullModelId}. Please check gcmp.vision.model configuration.`);
    }

    const userPrompt = prompt || 'Please describe this image in detail.';
    const dataBytes = Buffer.from(base64, 'base64');
    const imageData = new vscode.LanguageModelDataPart(dataBytes, mimeType);
    const textPart = new vscode.LanguageModelTextPart(userPrompt);
    const systemMessage = new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.System,
        VISION_SYSTEM_PROMPT
    );
    const userMessage = vscode.LanguageModelChatMessage.User([textPart, imageData]);

    const cts = token ? undefined : new vscode.CancellationTokenSource();
    try {
        const response = await model.sendRequest([systemMessage, userMessage], {}, token ?? cts!.token);

        let content = '';
        for await (const chunk of response.text) {
            content += chunk;
        }

        return { content };
    } finally {
        cts?.dispose();
    }
}

// ─── 统一入口 ──────────────────────────────────────────────────────────

/**
 * 分析图片视觉内容
 * 根据 gcmp.vision.provider 配置自动路由到 API 路径或 LLM 模型路径
 */
export async function analyzeImage(
    filePath: string,
    prompt?: string,
    token?: vscode.CancellationToken
): Promise<VisionResult> {
    const config = vscode.workspace.getConfiguration('gcmp');
    const providerType = config.get<string>('vision.provider', 'minimax_mcp_understand_image');

    if (providerType === 'minimax_mcp_understand_image') {
        Logger.trace('[gcmp_visionTool] Routing to MiniMax Vision API');
        return analyzeViaMinimaxAPI(filePath, prompt, token);
    }

    // providerType === 'model'
    const modelConfig = config.get<{ provider: string; model: string }>('vision.model', { provider: '', model: '' });
    if (modelConfig?.provider && modelConfig?.model) {
        Logger.trace(`[gcmp_visionTool] Routing to model delegate: ${modelConfig.provider}/${modelConfig.model}`);
        return analyzeViaModel(filePath, prompt, modelConfig.provider, modelConfig.model, token);
    }

    Logger.warn('[gcmp_visionTool] vision.model is not configured, falling back to MiniMax API');
    return analyzeViaMinimaxAPI(filePath, prompt, token);
}
