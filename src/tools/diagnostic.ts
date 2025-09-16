/*---------------------------------------------------------------------------------------------
 *  工具调试和诊断辅助函数
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';

/**
 * 检查语言模型工具的注册状态
 */
export async function checkToolRegistration(): Promise<void> {
    Logger.info('🔍 [工具诊断] 开始检查工具注册状态');

    try {
        // 检查 vscode.lm API 可用性
        if (!vscode.lm) {
            Logger.error('❌ [工具诊断] vscode.lm API 不可用');
            return;
        }

        // 检查工具列表
        if (!vscode.lm.tools) {
            Logger.error('❌ [工具诊断] vscode.lm.tools 不可用');
            return;
        }

        const allTools = vscode.lm.tools;
        Logger.info(`📊 [工具诊断] 发现 ${allTools.length} 个已注册的工具`);

        // 查找我们的工具
        const gcmpTools = allTools.filter(tool => tool.name.startsWith('gcmp_'));
        Logger.info(`🎯 [工具诊断] 发现 ${gcmpTools.length} 个 GCMP 工具`);

        for (const tool of gcmpTools) {
            Logger.info(`✅ [工具诊断] 工具: ${tool.name}`);
            Logger.info(`   描述: ${tool.description || '无'}`);
            Logger.info(`   标签: ${tool.tags?.join(', ') || '无'}`);
            Logger.info(`   输入Schema: ${tool.inputSchema ? 'Yes' : 'No'}`);
        }

        // 检查特定工具
        const applyDiffV2Tool = allTools.find(tool => tool.name === 'gcmp_applyDiffV2');
        if (applyDiffV2Tool) {
            Logger.info('🎉 [工具诊断] gcmp_applyDiffV2 工具已正确注册');
        } else {
            Logger.warn('⚠️ [工具诊断] gcmp_applyDiffV2 工具未找到');
        }

        const applyDiffTool = allTools.find(tool => tool.name === 'gcmp_applyDiff');
        if (applyDiffTool) {
            Logger.info('🎉 [工具诊断] gcmp_applyDiff 工具已正确注册');
        } else {
            Logger.warn('⚠️ [工具诊断] gcmp_applyDiff 工具未找到');
        }

        const zhipuTool = allTools.find(tool => tool.name === 'gcmp_zhipuWebSearch');
        if (zhipuTool) {
            Logger.info('🎉 [工具诊断] gcmp_zhipuWebSearch 工具已正确注册');
        } else {
            Logger.warn('⚠️ [工具诊断] gcmp_zhipuWebSearch 工具未找到');
        }

    } catch (error) {
        Logger.error('❌ [工具诊断] 检查工具注册状态时出错', error instanceof Error ? error : undefined);
    }
}

/**
 * 检查配置状态
 */
export function checkConfiguration(): void {
    Logger.info('🔧 [配置诊断] 检查配置状态');

    try {
        const config = vscode.workspace.getConfiguration('gcmp');
        const applyDiffEnabled = config.get<boolean>('applyDiff.enabled', false);
        const applyDiffV2Enabled = config.get<boolean>('applyDiff.v2Enabled', true);

        Logger.info(`📝 [配置诊断] Apply Diff V1 启用状态: ${applyDiffEnabled}`);
        Logger.info(`📝 [配置诊断] Apply Diff V2 启用状态: ${applyDiffV2Enabled}`);

        if (!applyDiffV2Enabled) {
            Logger.warn('⚠️ [配置诊断] Apply Diff V2 已被禁用，请检查配置 gcmp.applyDiff.v2Enabled');
        }

    } catch (error) {
        Logger.error('❌ [配置诊断] 检查配置时出错', error instanceof Error ? error : undefined);
    }
}

/**
 * 测试工具调用
 */
export async function testToolInvocation(): Promise<void> {
    Logger.info('🧪 [工具测试] 开始测试工具调用');

    try {
        // 检查是否可以调用工具
        if (!vscode.lm.invokeTool) {
            Logger.error('❌ [工具测试] vscode.lm.invokeTool API 不可用');
            return;
        }

        // 测试调用 V2 工具（预览模式）
        const testInput = {
            path: 'test.txt',
            diff: `
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
Hello World
=======
Hello VS Code
>>>>>>> REPLACE`,
            preview: true
        };

        Logger.info('🚀 [工具测试] 正在测试 gcmp_applyDiffV2 工具调用...');

        try {
            const options: vscode.LanguageModelToolInvocationOptions<typeof testInput> = {
                toolInvocationToken: undefined,
                input: testInput
            };

            const result = await vscode.lm.invokeTool('gcmp_applyDiffV2', options);
            Logger.info('✅ [工具测试] 工具调用成功');
            Logger.info(`📄 [工具测试] 结果: ${result.toString()}`);
        } catch (toolError) {
            Logger.error('❌ [工具测试] 工具调用失败', toolError instanceof Error ? toolError : undefined);
        }

    } catch (error) {
        Logger.error('❌ [工具测试] 测试工具调用时出错', error instanceof Error ? error : undefined);
    }
}

/**
 * 完整的诊断报告
 */
export async function generateDiagnosticReport(): Promise<void> {
    Logger.info('📋 [完整诊断] 开始生成诊断报告');

    try {
        // 检查VS Code版本
        const vsCodeVersion = vscode.version;
        Logger.info(`🔢 [版本信息] VS Code 版本: ${vsCodeVersion}`);

        // 检查扩展模式
        const extensionMode = vscode.extensions.getExtension('vicanent.gcmp')?.extensionKind;
        Logger.info(`🔧 [扩展信息] 扩展模式: ${extensionMode}`);

        // 检查工作区
        const workspaceFolders = vscode.workspace.workspaceFolders;
        Logger.info(`📁 [工作区] 工作区文件夹数: ${workspaceFolders?.length || 0}`);

        // 检查配置
        checkConfiguration();

        // 检查工具注册
        await checkToolRegistration();

        // 测试工具调用
        await testToolInvocation();

        Logger.info('📋 [完整诊断] 诊断报告生成完成');

    } catch (error) {
        Logger.error('❌ [完整诊断] 生成诊断报告时出错', error instanceof Error ? error : undefined);
    }
}

/**
 * 注册诊断命令
 */
export function registerDiagnosticCommands(context: vscode.ExtensionContext): void {
    const diagnosticCommand = vscode.commands.registerCommand('gcmp.tools.diagnostic', async () => {
        try {
            await vscode.window.showInformationMessage('🔍 正在运行工具诊断，请查看输出窗口获取详细信息...');
            await generateDiagnosticReport();
            await vscode.window.showInformationMessage('✅ 诊断完成，请查看输出窗口获取详细结果');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            await vscode.window.showErrorMessage(`诊断失败: ${errorMessage}`);
        }
    });

    context.subscriptions.push(diagnosticCommand);
    Logger.info('✅ [命令] 工具诊断命令已注册: gcmp.tools.diagnostic');
}