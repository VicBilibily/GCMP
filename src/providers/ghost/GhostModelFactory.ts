/*---------------------------------------------------------------------------------------------
 *  Ghost Model Factory - 模型工厂
 *  根据配置选择合适的模型实现
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GhostModel } from './GhostModel';
import { GhostLanguageModel } from './GhostLanguageModel';
import { Logger } from '../../utils/logger';
import type { ApiUsage, StreamChunk } from './types';

/**
 * 模型接口（统一两种实现）
 */
export interface IGhostModel {
    loaded: boolean;
    hasValidCredentials(): boolean;
    getModelName(): string;
    reload(): Promise<void>;
    generateCompletion(
        systemPrompt: string,
        userPrompt: string,
        onChunk?: (chunk: StreamChunk) => void,
        token?: vscode.CancellationToken
    ): Promise<{ text: string; usage: ApiUsage }>;
}

/**
 * 模型提供商类型
 */
export type ModelProvider = 'vscode' | 'zhipu';

/**
 * 模型工厂
 */
export class GhostModelFactory {
    /**
     * 创建模型实例
     */
    public static async createModel(provider?: ModelProvider): Promise<IGhostModel> {
        // 如果没有指定，从配置读取
        if (!provider) {
            const config = vscode.workspace.getConfiguration('gcmp.ghost');
            provider = config.get<ModelProvider>('modelProvider', 'vscode');
        }

        Logger.info(`Ghost: 创建 ${provider} 模型实例`);

        if (provider === 'vscode') {
            return await this.createVSCodeModel();
        } else {
            return await this.createZhipuModel();
        }
    }

    /**
     * 创建 VS Code 语言模型（优先方案）
     */
    private static async createVSCodeModel(): Promise<IGhostModel> {
        const model = new GhostLanguageModel();

        // 等待初始化完成
        await new Promise(resolve => setTimeout(resolve, 100));

        if (!model.loaded || !model.hasValidCredentials()) {
            Logger.warn('VS Code 语言模型初始化失败，尝试降级到智谱 API');
            return await this.createZhipuModel();
        }

        Logger.info('✓ 使用 VS Code 语言模型 (GitHub Copilot)');
        return model;
    }

    /**
     * 创建智谱 API 模型（备选方案）
     */
    private static async createZhipuModel(): Promise<IGhostModel> {
        const model = new GhostModel();

        // 等待初始化完成
        await new Promise(resolve => setTimeout(resolve, 100));

        if (!model.loaded || !model.hasValidCredentials()) {
            Logger.warn('智谱 API 模型未配置或初始化失败');
            vscode.window.showWarningMessage(
                'Ghost 代码补全未配置。请选择模型提供商或配置 API Key。',
                '配置'
            ).then(selection => {
                if (selection === '配置') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'gcmp.ghost');
                }
            });
        } else {
            Logger.info('✓ 使用智谱 API 模型');
        }

        return model;
    }

    /**
     * 自动选择最佳模型（智能降级）
     */
    public static async createBestAvailableModel(): Promise<IGhostModel> {
        Logger.info('Ghost: 自动选择最佳可用模型...');

        // 1. 优先尝试 VS Code 语言模型
        try {
            const vscodeModel = new GhostLanguageModel();
            await new Promise(resolve => setTimeout(resolve, 100));

            if (vscodeModel.loaded && vscodeModel.hasValidCredentials()) {
                Logger.info('✓ 自动选择: VS Code 语言模型 (GitHub Copilot)');
                return vscodeModel;
            }
        } catch (error) {
            Logger.warn('VS Code 语言模型不可用:', error);
        }

        // 2. 降级到智谱 API
        Logger.info('→ 降级到智谱 API');
        return await this.createZhipuModel();
    }

    /**
     * 检查模型可用性
     */
    public static async checkAvailability(provider: ModelProvider): Promise<boolean> {
        try {
            const model = await this.createModel(provider);
            return model.loaded && model.hasValidCredentials();
        } catch (error) {
            Logger.error(`检查 ${provider} 模型可用性失败:`, error);
            return false;
        }
    }
}
