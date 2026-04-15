/*---------------------------------------------------------------------------------------------
 *  MiniMax 图片理解工具
 *  使用 Coding Plan API 直接进行 HTTP 请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { ConfigManager, Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
import { StatusBarManager } from '../status';

/**
 * MiniMax 图片理解请求参数
 */
export interface MiniMaxVisionRequest {
    prompt: string; // 问题或分析请求
    image_url: string; // 图片地址（HTTP/HTTPS URL 或 data URL）
}

/**
 * MiniMax 图片理解响应
 */
export interface MiniMaxVisionResponse {
    content: string; // 图片分析结果文本
}

/**
 * MiniMax 图片理解工具
 */
export class MiniMaxVisionTool {
    private getBaseURL(): string {
        // 根据接入点配置返回对应的 base URL
        if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
            return 'https://api.minimax.io';
        }
        return 'https://api.minimaxi.com';
    }

    /**
     * 执行图片理解
     */
    async understand(params: MiniMaxVisionRequest): Promise<MiniMaxVisionResponse> {
        const apiKey = await ApiKeyManager.getApiKey('minimax-coding');
        if (!apiKey) {
            throw new Error('MiniMax Coding Plan API密钥未设置，请先运行命令"GCMP: 设置 MiniMax Coding Plan API密钥"');
        }

        const requestData = JSON.stringify({
            prompt: params.prompt,
            image_url: params.image_url
        });

        const requestUrl = `${this.getBaseURL()}/v1/coding_plan/vlm`;

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestData),
                'User-Agent': VersionManager.getUserAgent('MiniMaxVision')
            }
        };

        Logger.info(`🔍 [MiniMax 图片理解] 开始分析图片`);
        Logger.debug(`📝 [MiniMax 图片理解] 请求数据: prompt="${params.prompt}", image_url=${params.image_url}`);

        return new Promise((resolve, reject) => {
            const req = https.request(requestUrl, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        Logger.debug(`📊 [MiniMax 图片理解] 响应状态码: ${res.statusCode}`);
                        Logger.debug(`📄 [MiniMax 图片理解] 响应数据: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `MiniMax图片理解API错误 ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }
                            Logger.error('❌ [MiniMax 图片理解] API返回错误', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const response = JSON.parse(data) as MiniMaxVisionResponse;
                        Logger.info(`✅ [MiniMax 图片理解] 分析完成`);
                        resolve(response);
                    } catch (error) {
                        Logger.error('❌ [MiniMax 图片理解] 解析响应失败', error instanceof Error ? error : undefined);
                        reject(
                            new Error(
                                `解析MiniMax图片理解响应失败: ${error instanceof Error ? error.message : '未知错误'}`
                            )
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [MiniMax 图片理解] 请求失败', error);
                reject(new Error(`MiniMax图片理解请求失败: ${error.message}`));
            });

            req.write(requestData);
            req.end();
        });
    }

    /**
     * 直接理解图片数据（用于图片桥接功能）
     * @param imageData 图片的二进制数据
     * @param mimeType 图片的 MIME 类型
     * @param prompt 可选的提示词，默认是"描述这张图片"
     */
    async understandImage(
        imageData: Uint8Array,
        mimeType: string,
        prompt = '描述这张图片'
    ): Promise<MiniMaxVisionResponse> {
        // 将图片数据转换为 data URL
        const base64Data = Buffer.from(imageData).toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        return this.understand({
            prompt,
            image_url: dataUrl
        });
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<MiniMaxVisionRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [工具调用] MiniMax图片理解工具被调用: ${JSON.stringify(request.input)}`);

            const params = request.input as MiniMaxVisionRequest;
            if (!params.prompt) {
                throw new Error('缺少必需参数: prompt');
            }
            if (!params.image_url) {
                throw new Error('缺少必需参数: image_url');
            }

            const response = await this.understand(params);
            Logger.info('✅ [工具调用] MiniMax图片理解工具调用成功');

            StatusBarManager.minimax?.delayedUpdate();

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(response.content)
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [工具调用] MiniMax图片理解工具调用失败', error instanceof Error ? error : undefined);
            throw new vscode.LanguageModelError(`MiniMax图片理解失败: ${errorMessage}`);
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [MiniMax 图片理解] 工具资源已清理');
        } catch (error) {
            Logger.error('❌ [MiniMax 图片理解] 资源清理失败', error instanceof Error ? error : undefined);
        }
    }
}