/*---------------------------------------------------------------------------------------------
 *  工具注册器
 *  管理所有工具的注册和生命周期
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipu-search';
import { ApplyDiffTool } from './apply-diff';

/**
 * 注册所有工具
 */
export function registerAllTools(context: vscode.ExtensionContext): void {
    Logger.info('🔧 [工具注册] 开始注册所有工具');

    try {
        // 注册智谱AI搜索工具
        const zhipuSearchTool = new ZhipuSearchTool();
        const zhipuToolDisposable = vscode.lm.registerTool('gcmp_zhipuWebSearch', {
            invoke: zhipuSearchTool.invoke.bind(zhipuSearchTool)
        });
        context.subscriptions.push(zhipuToolDisposable);
        Logger.info('✅ [工具注册] 智谱AI搜索工具已注册: gcmp_zhipuWebSearch');

        // 注册Apply Diff工具
        const applyDiffTool = new ApplyDiffTool();
        const applyDiffDisposable = vscode.lm.registerTool('gcmp_applyDiff', {
            invoke: applyDiffTool.invoke.bind(applyDiffTool)
        });
        context.subscriptions.push(applyDiffDisposable);
        Logger.info('✅ [工具注册] Apply Diff 工具已注册: gcmp_applyDiff');

        Logger.info('🎉 [工具注册] 所有工具注册完成');
    } catch (error) {
        Logger.error('❌ [工具注册] 工具注册失败', error instanceof Error ? error : undefined);
        throw error;
    }
}

