/*---------------------------------------------------------------------------------------------
 *  辅助工具模型设置向导
 *  统一入口：让用户选择设置“提交消息生成模型”或“视觉分析模型”。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { t } from '../utils/l10n';

interface ModelSettingOption extends vscode.QuickPickItem {
    action: 'commit' | 'vision';
}

/**
 * 打开辅助工具模型设置向导
 */
export async function openModelSettingsWizard(): Promise<void> {
    try {
        const items: ModelSettingOption[] = [
            {
                label: t('Commit Message Model', '提交消息模型'),
                description: t('Set the model for generating commit messages', '设置用于生成提交消息的模型'),
                action: 'commit'
            },
            {
                label: t('Vision Analysis Model', '视觉分析模型'),
                description: t('Set the model for image/vision analysis', '设置用于图像/视觉分析的模型'),
                action: 'vision'
            }
        ];

        const picked = await vscode.window.showQuickPick<ModelSettingOption>(items, {
            placeHolder: t('Select the auxiliary tool model to configure', '选择要设置的辅助工具模型')
        });

        if (!picked) {
            return;
        }

        if (picked.action === 'vision') {
            await vscode.commands.executeCommand('gcmp.vision.selectModel');
        } else {
            await vscode.commands.executeCommand('gcmp.commit.selectModel');
        }
    } catch (err) {
        Logger.error('[ModelSettingsWizard] Failed:', err);
        vscode.window.showErrorMessage(
            t('Failed to open auxiliary tool model settings wizard.', '打开辅助工具模型设置向导失败。')
        );
    }
}
