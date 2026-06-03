/*---------------------------------------------------------------------------------------------
 *  工具注册器
 *  管理所有工具的注册和生命周期
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipuSearch';
import { MiniMaxSearchTool } from './minimaxSearch';
import { KimiSearchTool } from './kimiSearch';
import { DashscopeSearchTool } from './dashscopeSearch';
import { ToolContextManager } from './toolContextManager';

// 全局工具实例管理
let zhipuSearchTool: ZhipuSearchTool | undefined;
let minimaxSearchTool: MiniMaxSearchTool | undefined;
let kimiSearchTool: KimiSearchTool | undefined;
let dashscopeSearchTool: DashscopeSearchTool | undefined;

/**
 * 注册所有工具
 */
export function registerAllTools(context: vscode.ExtensionContext): void {
    try {
        // 初始化工具上下文（setContext + 监听 API Key 变更）
        ToolContextManager.initialize(context);

        // 注册智谱AI联网搜索工具
        zhipuSearchTool = new ZhipuSearchTool();
        const zhipuToolDisposable = vscode.lm.registerTool('gcmp_zhipuWebSearch', {
            invoke: zhipuSearchTool.invoke.bind(zhipuSearchTool),
            prepareInvocation: zhipuSearchTool.prepareInvocation.bind(zhipuSearchTool)
        });
        context.subscriptions.push(zhipuToolDisposable);

        // 注册MiniMax网络搜索工具
        minimaxSearchTool = new MiniMaxSearchTool();
        const minimaxToolDisposable = vscode.lm.registerTool('gcmp_minimaxWebSearch', {
            invoke: minimaxSearchTool.invoke.bind(minimaxSearchTool),
            prepareInvocation: minimaxSearchTool.prepareInvocation.bind(minimaxSearchTool)
        });
        context.subscriptions.push(minimaxToolDisposable);

        // 注册Kimi网络搜索工具
        kimiSearchTool = new KimiSearchTool();
        const kimiToolDisposable = vscode.lm.registerTool('gcmp_kimiWebSearch', {
            invoke: kimiSearchTool.invoke.bind(kimiSearchTool),
            prepareInvocation: kimiSearchTool.prepareInvocation.bind(kimiSearchTool)
        });
        context.subscriptions.push(kimiToolDisposable);

        // 注册阿里云百炼联网搜索工具
        dashscopeSearchTool = new DashscopeSearchTool();
        const dashscopeToolDisposable = vscode.lm.registerTool('gcmp_dashscopeWebSearch', {
            invoke: dashscopeSearchTool.invoke.bind(dashscopeSearchTool),
            prepareInvocation: dashscopeSearchTool.prepareInvocation.bind(dashscopeSearchTool)
        });
        context.subscriptions.push(dashscopeToolDisposable);

        // 添加清理逻辑到context
        context.subscriptions.push({
            dispose: async () => {
                await cleanupAllTools();
            }
        });

        Logger.debug('ZhipuAI web search tool registered: gcmp_zhipuWebSearch');
        Logger.debug('MiniMax web search tool registered: gcmp_minimaxWebSearch');
        Logger.debug('Kimi web search tool registered: gcmp_kimiWebSearch');
        Logger.debug('DashScope web search tool registered: gcmp_dashscopeWebSearch');
    } catch (error) {
        Logger.error('Tool registration failed', error instanceof Error ? error : undefined);
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
            Logger.info('✅ ZhipuAI web search tool resources cleaned up');
        }

        if (minimaxSearchTool) {
            await minimaxSearchTool.cleanup();
            minimaxSearchTool = undefined;
            Logger.info('✅ MiniMax web search tool resources cleaned up');
        }

        if (kimiSearchTool) {
            await kimiSearchTool.cleanup();
            kimiSearchTool = undefined;
            Logger.info('✅ Kimi web search tool resources cleaned up');
        }

        if (dashscopeSearchTool) {
            await dashscopeSearchTool.cleanup();
            dashscopeSearchTool = undefined;
            Logger.info('✅ DashScope web search tool resources cleaned up');
        }
    } catch (error) {
        Logger.error('❌ Tool cleanup failed', error instanceof Error ? error : undefined);
    }
}
