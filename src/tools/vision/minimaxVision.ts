/*---------------------------------------------------------------------------------------------
 *  MiniMax 图片理解工具
 *  使用 Token Plan API 直接进行 HTTP 请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigManager } from '../../utils';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { t } from '../../utils/l10n';
import { VersionManager } from '../../utils/versionManager';
import { StatusBarManager } from '../../status';

/**
 * MiniMax 图片理解请求参数
 */
export interface MiniMaxVisionRequest {
    prompt: string;
    image_url: string;
}

/**
 * MiniMax 图片理解响应
 */
export interface MiniMaxVisionResponse {
    content: string;
}

/**
 * MiniMax 图片理解工具
 */
export class MiniMaxVisionTool {
    private getBaseURL(): string {
        if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
            return 'https://api.minimax.io';
        }
        return 'https://api.minimaxi.com';
    }

    async understand(params: MiniMaxVisionRequest, abortSignal?: AbortSignal): Promise<MiniMaxVisionResponse> {
        const apiKey = await ApiKeyManager.getApiKey('minimax-token');
        if (!apiKey) {
            throw new Error(
                t(
                    'MiniMax Token Plan API key is not set. Run "GCMP: Set MiniMax Token Plan API Key" first',
                    'MiniMax Token Plan API密钥未设置，请先运行命令"GCMP: 设置 MiniMax Token Plan API密钥"'
                )
            );
        }

        const requestData = JSON.stringify({
            prompt: params.prompt,
            image_url: params.image_url
        });

        const requestUrl = `${this.getBaseURL()}/v1/coding_plan/vlm`;

        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        const timeoutId = setTimeout(() => abortController.abort(), 60000);

        const requestOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': VersionManager.getUserAgent('MiniMaxVision')
            },
            body: requestData,
            signal: abortController.signal
        };

        if (abortSignal) {
            if (abortSignal.aborted) {
                abortController.abort();
            } else {
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
        }

        try {
            const response = await ConfigManager.fetchWithProxy(requestUrl, requestOptions, {
                providerKey: 'minimax-token'
            });
            const data = await response.text();

            if (!response.ok) {
                let errorMessage = t(
                    'MiniMax image understanding API error {0}',
                    'MiniMax图片理解API错误 {0}',
                    response.status
                );
                try {
                    const errorData = JSON.parse(data);
                    errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch {
                    errorMessage += `: ${data}`;
                }
                throw new Error(errorMessage);
            }

            return JSON.parse(data) as MiniMaxVisionResponse;
        } catch (error) {
            if (abortSignal?.aborted) {
                throw new Error(t('Image understanding request was cancelled by the user', '用户取消了图片理解请求'));
            }
            if (abortController.signal.aborted) {
                throw new Error(
                    t('MiniMax image understanding request timed out (60s)', 'MiniMax图片理解请求超时（60秒）')
                );
            }
            throw new Error(
                t(
                    'MiniMax image understanding request failed: {0}',
                    'MiniMax图片理解请求失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                )
            );
        } finally {
            clearTimeout(timeoutId);
            if (abortSignal) {
                abortSignal.removeEventListener('abort', onAbort);
            }
        }
    }

    async understandImage(
        imageData: Uint8Array,
        mimeType: string,
        prompt = '描述这张图片',
        abortSignal?: AbortSignal
    ): Promise<MiniMaxVisionResponse> {
        const base64Data = Buffer.from(imageData).toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        return this.understand({ prompt, image_url: dataUrl }, abortSignal);
    }

    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<MiniMaxVisionRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const params = request.input as MiniMaxVisionRequest;

            if (!params.prompt) {
                throw new Error(t('Missing required parameter: prompt', '缺少必需参数: prompt'));
            }
            if (!params.image_url) {
                throw new Error(t('Missing required parameter: image_url', '缺少必需参数: image_url'));
            }

            const response = await this.understand(params);
            StatusBarManager.minimax?.delayedUpdate();

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(response.content)]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t('Unknown error', '未知错误');
            throw new vscode.LanguageModelError(
                t('MiniMax image understanding failed: {0}', 'MiniMax图片理解失败: {0}', errorMessage)
            );
        }
    }

    async cleanup(): Promise<void> {
        // 目前无需清理的资源
    }
}
