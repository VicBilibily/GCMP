/*---------------------------------------------------------------------------------------------
 *  Commit 命令系统
 *  注册和处理提交消息生成相关的命令
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GeneratorService } from './generatorService';
import { CommitMessage } from './commitMessage';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';
import { Repository } from '../types/git';

/**
 * 检查提交消息生成功能是否启用
 */
function isCommitEnabled(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>('enabled', true);
}

/**
 * 注册所有 Commit 相关命令
 */
export function registerCommitCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // 监听配置变更，动态更新 SCM 按钮可见性
    function updateScmVisibility() {
        const config = vscode.workspace.getConfiguration('gcmp.commit');
        const enabled = isCommitEnabled(config);
        vscode.commands.executeCommand('setContext', 'gcmp.commitEnabled', enabled);
        Logger.debug(`[Commit] Feature ${enabled ? 'enabled' : 'disabled'}`);
    }

    // 初始化状态
    updateScmVisibility();

    // 配置变更监听
    disposables.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gcmp.commit.enabled')) {
                updateScmVisibility();
            }
        })
    );

    // 注册生成提交消息命令
    disposables.push(
        vscode.commands.registerCommand('gcmp.commit.generateMessage', async (sourceControlRepository?: Repository) => {
            if (!isCommitEnabled(vscode.workspace.getConfiguration('gcmp.commit'))) {
                return;
            }
            await CommitMessage.generateAndSetCommitMessage(sourceControlRepository);
        })
    );

    // 暂存区按钮：强制仅分析 staged 变更
    disposables.push(
        vscode.commands.registerCommand(
            'gcmp.commit.generateMessageStaged',
            async (resContext?: vscode.SourceControlResourceGroup) => {
                if (!isCommitEnabled(vscode.workspace.getConfiguration('gcmp.commit'))) {
                    return;
                }
                await CommitMessage.generateAndSetCommitMessage(undefined, { scope: 'staged', resContext });
            }
        )
    );

    // 变更区按钮：强制分析 working tree（包含 tracked + untracked）
    disposables.push(
        vscode.commands.registerCommand(
            'gcmp.commit.generateMessageWorkingTree',
            async (resContext?: vscode.SourceControlResourceGroup) => {
                if (!isCommitEnabled(vscode.workspace.getConfiguration('gcmp.commit'))) {
                    return;
                }
                await CommitMessage.generateAndSetCommitMessage(undefined, { scope: 'workingTree', resContext });
            }
        )
    );

    // 注册选择模型命令
    disposables.push(
        vscode.commands.registerCommand('gcmp.commit.selectModel', async () => {
            try {
                // 1) 先选择提供商（providerKey），再选择该提供商的模型
                const providers = await GeneratorService.getAvailableCommitProviders();
                if (providers.length === 0) {
                    vscode.window.showWarningMessage(t('No GCMP providers are available.', '没有可用的 GCMP 提供商。'));
                    return;
                }

                const providerPick = await vscode.window.showQuickPick(
                    providers.map(p => ({
                        label: p.displayName,
                        description: p.providerKey,
                        detail: p.vendor,
                        providerKey: p.providerKey
                    })),
                    {
                        placeHolder: t(
                            'Select the provider used to generate commit messages',
                            '选择用于生成提交消息的提供商'
                        )
                    }
                );

                if (!providerPick) {
                    return;
                }

                const providerKey = (providerPick as unknown as { providerKey: string }).providerKey;
                const models = await GeneratorService.getAvailableCommitModelsForProvider(providerKey);

                const modelPick = await vscode.window.showQuickPick(
                    models.map(m => ({
                        label: m.name,
                        description: m.id,
                        detail: `${providerKey}:${m.id}`,
                        modelId: m.id,
                        modelName: m.name
                    })),
                    {
                        placeHolder: t(
                            'Select the model used to generate commit messages for this provider',
                            '选择该提供商下用于生成提交消息的模型'
                        )
                    }
                );

                if (!modelPick) {
                    return;
                }

                const { modelId, modelName } = modelPick;

                // 2) 更新配置（保存 provider + model）
                const config = vscode.workspace.getConfiguration('gcmp.commit');
                await config.update(
                    'model',
                    {
                        provider: providerKey,
                        model: modelId
                    },
                    vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage(
                    t('Selected model: {0}:{1}', '已选择模型: {0}:{1}', providerKey, modelName)
                );
            } catch (error) {
                Logger.error('[CommitCommands] Failed to select model:', error);
                vscode.window.showErrorMessage(t('Failed to select the model.', '选择模型失败。'));
            }
        })
    );

    // 添加到订阅
    context.subscriptions.push(...disposables);

    Logger.trace('[CommitCommands] Commit commands registered');

    return disposables;
}
