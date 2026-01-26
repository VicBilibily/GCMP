/*---------------------------------------------------------------------------------------------
 *  工具注册器
 *  管理所有工具的注册和生命周期
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipuSearch';
import { MiniMaxSearchTool } from './minimaxSearch';

// 全局工具实例管理
let zhipuSearchTool: ZhipuSearchTool | undefined;
let minimaxSearchTool: MiniMaxSearchTool | undefined;

/**
 * 注册所有工具
 */
export function registerAllTools(context: vscode.ExtensionContext): void {
    try {
        // 注册智谱AI联网搜索工具
        zhipuSearchTool = new ZhipuSearchTool();
        const zhipuToolDisposable = vscode.lm.registerTool('gcmp_zhipuWebSearch', {
            invoke: zhipuSearchTool.invoke.bind(zhipuSearchTool)
        });
        context.subscriptions.push(zhipuToolDisposable);

        // 注册MiniMax网络搜索工具
        minimaxSearchTool = new MiniMaxSearchTool();
        const minimaxToolDisposable = vscode.lm.registerTool('gcmp_minimaxWebSearch', {
            invoke: minimaxSearchTool.invoke.bind(minimaxSearchTool)
        });
        context.subscriptions.push(minimaxToolDisposable);

        // 添加清理逻辑到context
        context.subscriptions.push({
            dispose: async () => {
                await cleanupAllTools();
            }
        });

        Logger.debug('智谱AI联网搜索工具已注册: gcmp_zhipuWebSearch');
        Logger.debug('MiniMax网络搜索工具已注册: gcmp_minimaxWebSearch');
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
            Logger.info('✅ 智谱AI联网搜索工具资源已清理');
        }

        if (minimaxSearchTool) {
            await minimaxSearchTool.cleanup();
            minimaxSearchTool = undefined;
            Logger.info('✅ MiniMax网络搜索工具资源已清理');
        }
    } catch (error) {
        Logger.error('❌ 工具清理失败', error instanceof Error ? error : undefined);
    }
}
