/*---------------------------------------------------------------------------------------------
 *  Vision 统一分析入口
 *  根据配置自动路由：
 *    - vision.provider === "minimax_mcp_understand_image" → MiniMax Token Plan Vision API（专用 HTTP 接口）
 *    - vision.provider === "model"   → 委派给原生支持多模态的 GCMP 模型（LLM 聊天模型）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger, ConfigManager, ApiKeyManager } from '../../utils';
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
 * 支持的图片扩展名集合
 */
const SUPPORTED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']);

/**
 * 前置验证：检查文件、令牌、配置是否可用，
 * 若配置不完整则尝试回退或拉起向导。
 * @returns 最终可用的配置类型，调用者直接按此值路由
 */
async function resolveVisionRoute(
    filePath: string,
    token?: vscode.CancellationToken
): Promise<{ route: 'minimax_api' | 'model'; modelProvider?: string; modelId?: string }> {
    // 1. 基本输入验证
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Image file not found: ${filePath}`);
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
        Logger.warn(`[gcmp_visionTool] Unsupported image extension: .${ext}, trying anyway`);
    }

    if (token?.isCancellationRequested) {
        throw new Error('Vision analysis cancelled before processing started.');
    }

    // 2. 读取配置
    const visionCfg = ConfigManager.getConfig().vision;
    const providerType = visionCfg.provider;

    // 3. 验证已知的 provider 值
    if (providerType !== 'minimax_mcp_understand_image' && providerType !== 'model') {
        Logger.warn(`[gcmp_visionTool] Unknown vision.provider: "${providerType}", treating as unconfigured`);
    }

    // 4. 按配置类型判断可用性
    if (providerType === 'minimax_mcp_understand_image') {
        const hasKey = await ApiKeyManager.hasValidApiKey('minimax-token');
        if (hasKey) {
            return { route: 'minimax_api' };
        }
        // MiniMax 没 key → 先尝试 model 回退（若 model 配置已存在）
        if (visionCfg.model.provider && visionCfg.model.model) {
            Logger.warn('[gcmp_visionTool] minimax-token key not found, falling back to model delegate');
            return { route: 'model', modelProvider: visionCfg.model.provider, modelId: visionCfg.model.model };
        }
        Logger.warn('[gcmp_visionTool] minimax-token key not found and no model configured, launching wizard');
    } else if (providerType === 'model') {
        if (visionCfg.model.provider && visionCfg.model.model) {
            return { route: 'model', modelProvider: visionCfg.model.provider, modelId: visionCfg.model.model };
        }
        // model 模式配置不完整：尝试回退
        const hasKey = await ApiKeyManager.hasValidApiKey('minimax-token');
        if (hasKey) {
            Logger.warn('[gcmp_visionTool] vision.model is not configured, falling back to MiniMax API');
            return { route: 'minimax_api' };
        }
    }

    // 5. 完全未配置 / 回退不可用 → 拉起向导
    Logger.warn('[gcmp_visionTool] No vision config found and no minimax-token key, launching wizard');
    const wizardModule = await import('./wizard');
    await wizardModule.selectVisionModel();

    // 向导完成后重试（缓存已由 onDidChangeConfiguration 清除）
    const retryCfg = ConfigManager.getConfig().vision;
    if (retryCfg.provider === 'minimax_mcp_understand_image') {
        const hasKey = await ApiKeyManager.hasValidApiKey('minimax-token');
        if (!hasKey) {
            throw new Error('MiniMax Vision API was selected in the wizard but no minimax-token key is available.');
        }
        Logger.trace('[gcmp_visionTool] Wizard set MiniMax API, routing now');
        return { route: 'minimax_api' };
    }

    if (retryCfg.provider === 'model' && retryCfg.model.provider && retryCfg.model.model) {
        Logger.trace(`[gcmp_visionTool] Wizard set model delegate: ${retryCfg.model.provider}/${retryCfg.model.model}`);
        return { route: 'model', modelProvider: retryCfg.model.provider, modelId: retryCfg.model.model };
    }

    throw new Error(
        'Vision analysis is not configured. Please configure a vision backend via the wizard or set gcmp.vision.provider/gcmp.vision.model in settings.'
    );
}

/**
 * 分析图片视觉内容
 * 根据 gcmp.vision.provider 配置自动路由到 API 路径或 LLM 模型路径。
 * 当 model 模式未配置且无 minimax-token 密钥时，拉起配置向导让用户选择。
 */
export async function analyzeImage(
    filePath: string,
    prompt?: string,
    token?: vscode.CancellationToken
): Promise<VisionResult> {
    const route = await resolveVisionRoute(filePath, token);

    if (route.route === 'minimax_api') {
        Logger.trace('[gcmp_visionTool] Routing to MiniMax Vision API');
        return analyzeViaMinimaxAPI(filePath, prompt, token);
    }

    Logger.trace(`[gcmp_visionTool] Routing to model delegate: ${route.modelProvider}/${route.modelId}`);
    return analyzeViaModel(filePath, prompt, route.modelProvider!, route.modelId!, token);
}
