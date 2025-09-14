/*---------------------------------------------------------------------------------------------
 *  工具注册器
 *  管理所有工具的注册和生命周期
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipu-search';

/**
 * 注册所有工具
 */
export function registerAllTools(context: vscode.ExtensionContext): void {
    Logger.info('🔧 [工具注册] 开始注册所有工具');

    try {
        // 检查 vscode.lm.registerTool 是否可用
        if (!vscode.lm || !vscode.lm.registerTool) {
            Logger.error('❌ [工具注册] vscode.lm.registerTool API 不可用，请检查 VS Code 版本和 API 提案配置');
            throw new Error('vscode.lm.registerTool API 不可用');
        }

        // 注册智谱AI搜索工具
        const zhipuSearchTool = new ZhipuSearchTool();

        const zhipuToolDisposable = vscode.lm.registerTool('gcmp_zhipuWebSearch', {
            invoke: zhipuSearchTool.invoke.bind(zhipuSearchTool)
        });

        context.subscriptions.push(zhipuToolDisposable);
        Logger.info('✅ [工具注册] 智谱AI搜索工具已注册: gcmp_zhipuWebSearch');

        Logger.info('🎉 [工具注册] 所有工具注册完成');

    } catch (error) {
        Logger.error('❌ [工具注册] 工具注册失败', error instanceof Error ? error : undefined);
        throw error;
    }
}

