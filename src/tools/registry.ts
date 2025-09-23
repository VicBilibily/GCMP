/*---------------------------------------------------------------------------------------------
 *  工具注册器
 *  管理所有工具的注册和生命周期
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipu-search';

// 全局工具实例管理
let zhipuSearchTool: ZhipuSearchTool | undefined;

/**
 * 注册所有工具
 */
export function registerAllTools(context: vscode.ExtensionContext): void {
    try {
        // 注册智谱AI搜索工具
        zhipuSearchTool = new ZhipuSearchTool();
        const zhipuToolDisposable = vscode.lm.registerTool('gcmp_zhipuWebSearch', {
            invoke: zhipuSearchTool.invoke.bind(zhipuSearchTool)
        });
        context.subscriptions.push(zhipuToolDisposable);

        // 添加清理逻辑到context
        context.subscriptions.push({
            dispose: async () => {
                await cleanupAllTools();
            }
        });

        Logger.info('智谱AI搜索工具已注册: gcmp_zhipuWebSearch');
    } catch (error) {
        Logger.error('工具注册失败', error instanceof Error ? error : undefined);
        throw error;
    }
}

/**
 * 清理所有工具资源
 */
export async function cleanupAllTools(): Promise<void> {
    try {
        if (zhipuSearchTool) {
            await zhipuSearchTool.cleanup();
            zhipuSearchTool = undefined;
            Logger.info('✅ 智谱AI搜索工具资源已清理');
        }
    } catch (error) {
        Logger.error('❌ 工具清理失败', error instanceof Error ? error : undefined);
    }
}

