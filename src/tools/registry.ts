/*---------------------------------------------------------------------------------------------
 *  工具注册器
 *  管理所有工具的注册和生命周期
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipu-search';
import { ApplyDiffTool } from './apply-diff';
import { runVSCodeIntegrationTests } from '../test/apply-diff-vscode-integration.test';

// 保存工具注册的 disposable 引用
let applyDiffDisposable: vscode.Disposable | undefined;
let applyDiffToolInstance: ApplyDiffTool | undefined;

/**
 * 注册或注销 Apply Diff 工具
 */
function toggleApplyDiffTool(context: vscode.ExtensionContext, enabled: boolean): void {
    if (enabled && !applyDiffDisposable) {
        // 注册工具
        applyDiffToolInstance = new ApplyDiffTool();
        applyDiffDisposable = vscode.lm.registerTool('gcmp_applyDiff', {
            invoke: applyDiffToolInstance.invoke.bind(applyDiffToolInstance)
        });
        context.subscriptions.push(applyDiffDisposable);
        Logger.info('✅ [工具注册] Apply Diff工具已注册: gcmp_applyDiff');
    } else if (!enabled && applyDiffDisposable) {
        // 注销工具
        applyDiffDisposable.dispose();
        applyDiffDisposable = undefined;

        // 清理工具实例资源
        if (applyDiffToolInstance) {
            applyDiffToolInstance.dispose();
            applyDiffToolInstance = undefined;
        }

        Logger.info('❌ [工具注册] Apply Diff工具已注销: gcmp_applyDiff');
    }
}

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

        // 检查是否启用Apply Diff工具
        const config = vscode.workspace.getConfiguration('gcmp');
        const isApplyDiffEnabled = config.get<boolean>('applyDiff.enabled', false);

        // 初始注册状态
        if (isApplyDiffEnabled) {
            toggleApplyDiffTool(context, true);
        } else {
            Logger.info('ℹ️ [工具注册] Apply Diff工具已禁用，跳过注册 (可在设置中启用: gcmp.applyDiff.enabled)');
        }

        // 监听配置变更
        const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('gcmp.applyDiff.enabled')) {
                const newConfig = vscode.workspace.getConfiguration('gcmp');
                const newEnabled = newConfig.get<boolean>('applyDiff.enabled', false);
                Logger.info(`🔄 [工具注册] Apply Diff工具配置变更: ${newEnabled ? '启用' : '禁用'}`);
                toggleApplyDiffTool(context, newEnabled);
            }
        });

        context.subscriptions.push(configChangeDisposable);

        // 注册VS Code集成测试命令（仅在开发模式下）
        if (context.extensionMode === vscode.ExtensionMode.Development) {
            const testCommand = vscode.commands.registerCommand('gcmp.test.vsCodeIntegration', async () => {
                try {
                    await runVSCodeIntegrationTests();
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : '未知错误';
                    Logger.error(`❌ [集成测试] VS Code集成测试失败: ${errorMessage}`);
                    vscode.window.showErrorMessage(`集成测试失败: ${errorMessage}`);
                }
            });
            context.subscriptions.push(testCommand);
            Logger.info('🧪 [工具注册] VS Code集成测试命令已注册 (开发模式)');
        }

        Logger.info('🎉 [工具注册] 所有工具注册完成');

    } catch (error) {
        Logger.error('❌ [工具注册] 工具注册失败', error instanceof Error ? error : undefined);
        throw error;
    }
}

